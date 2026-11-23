// The Production panel (plan 3.7): the player's war economy from the worker's `economy` query, in sections built once
// whose rows are kept per key and only their values rewritten (a number field being typed in is left alone):
// military factories in use and free; each production line (factories with - / + and a number field sending `line`
// orders, efficiency, output a day, what it lacks: coal, iron or oil sufficiency, or its lock), a refusal under its
// row; a new line for an item not yet produced, and the locked items with their unlock condition; the stock of each
// item with its change a day (output less what reinforcement takes) and how many divisions of each template the stock
// and manpower equip now; coal, iron and oil (own, imported, the blockade's share, sufficiency) with what a shortage
// does; manpower; construction (military or civil factory, infrastructure: picked on the map with ui/eco-pick.js,
// legal provinces from the `buildable` query, with cost and days) and its queue; training (ui/eco-train.js) and its
// queue. Panel id 'production'.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;
  const eco = () => ui.eco;

  // Keeps one row per key in a list element, in the order given; make(key) builds a row, fill(row, value) writes it.
  function keyed(list, make, fill) {
    const rows = new Map();
    return (entries) => {
      const keep = new Set();
      const order = [];
      for (const [key, value] of entries) {
        keep.add(key);
        let r = rows.get(key);
        if (!r) { r = make(key); rows.set(key, r); }
        fill(r, value);
        order.push(r.el);
      }
      for (const [k, r] of rows) if (!keep.has(k)) { r.el.remove(); rows.delete(k); }
      order.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null); });
    };
  }

  function mount(root) {
    root.classList.add('cq-production');
    const E = eco();
    let data = null;
    let seq = 0;

    // ---------- factories and lines ----------
    const facBody = E.section(root, tr('Military Factories'), 'cq-sec-factories');
    const facLine = el('div', 'cq-fac-line');
    const facBar = el('div', 'cq-bar-meter');
    const facFill = el('div', 'cq-bar-fill');
    facBar.append(facFill);
    facBody.append(facLine, facBar);

    const lineBody = E.section(root, tr('Production Lines'), 'cq-sec-lines');
    const lineHead = el('div', 'cq-line cq-line-head');
    for (const t of [tr('Item'), tr('Factories'), tr('Efficiency'), tr('Per day'), tr('Short of')]) lineHead.append(el('span', null, t));
    const lineList = el('div', 'cq-lines');
    lineBody.append(lineHead, lineList);
    const drawLines = keyed(lineList, (item) => {
      const r = { el: el('div', 'cq-line') };
      r.el.dataset.item = item;
      const name = el('span', 'cq-line-name', ui.text.item(item));
      r.step = E.stepper({ value: 0, min: 0, max: 999, cls: 'cq-line-factories', onSet: (v) => setLine(item, v, r) });
      r.eff = el('span', 'cq-line-eff');
      r.out = el('span', 'cq-line-out');
      r.lacks = el('span', 'cq-line-lacks');
      r.msg = el('div', 'cq-eco-msg cq-line-msg');
      r.msg.hidden = true;
      r.el.append(name, r.step.el, r.eff, r.out, r.lacks, r.msg);
      return r;
    }, (r, l) => {
      if (document.activeElement !== r.step.input) r.step.set(l.factories);
      r.el.dataset.factories = String(l.factories);
      r.el.dataset.perDay = String(l.perDay);
      r.eff.textContent = ui.text.percent(l.eff);
      r.out.textContent = E.tenths(l.perDay);
      r.out.title = l.used < l.factories ? tr('Only {n} of its factories run: the others are taken by the lines above it.', { n: l.used }) : '';
      r.lacks.replaceChildren(...l.lacks.map((k) => {
        const b = el('span', `cq-lack ${k === 'locked' ? 'locked' : ''}`, k === 'locked' ? ui.text.resource(k) : `${ui.text.resource(k)} ${ui.text.percent(data.resources[k].suff)}`);
        b.dataset.lack = k;
        return b;
      }));
      if (!l.lacks.length) r.lacks.append(el('span', 'cq-muted', '—'));
    });
    async function setLine(item, factories, r) {
      const res = await game.order({ type: 'line', item, factories });
      if (r) {
        r.msg.hidden = res.ok;
        r.msg.textContent = res.ok ? '' : ui.text.reason(res.reason);
        if (!res.ok && data) r.step.set(data.lines.find((l) => l.item === item)?.factories ?? 0);
      }
      return res;
    }

    const newLine = el('div', 'cq-new-line');
    const newItem = document.createElement('select');
    newItem.className = 'cq-select cq-new-item';
    const newCount = E.stepper({ value: 1, min: 1, max: 999, cls: 'cq-new-count', onSet: (v) => newCount.set(v) });
    const newGo = el('button', 'cq-btn cq-new-go', tr('Add Line'));
    const newMsg = el('div', 'cq-eco-msg cq-new-msg');
    newGo.onclick = async () => {
      if (!newItem.value) return;
      const res = await setLine(newItem.value, newCount.value, null);
      newMsg.textContent = res.ok ? '' : ui.text.reason(res.reason);
      newMsg.classList.toggle('bad', !res.ok);
    };
    newLine.append(el('span', 'cq-eco-label', tr('New line:')), newItem, newCount.el, newGo);
    const locked = el('div', 'cq-locked');
    lineBody.append(newLine, newMsg, locked);

    // ---------- stock ----------
    const stockBody = E.section(root, tr('Equipment'), 'cq-sec-stock');
    const stockHead = el('div', 'cq-stock cq-stock-head');
    for (const t of [tr('Item'), tr('In stock'), tr('A day')]) stockHead.append(el('span', null, t));
    const stockList = el('div', 'cq-stock-list');
    const equipList = el('div', 'cq-equip-list');
    stockBody.append(stockHead, stockList, el('div', 'cq-eco-sub', tr('Divisions the stock and manpower equip now:')), equipList);
    const drawStock = keyed(stockList, (item) => {
      const r = { el: el('div', 'cq-stock') };
      r.el.dataset.item = item;
      r.have = el('span', 'cq-stock-have');
      r.day = el('span', 'cq-stock-day');
      r.el.append(el('span', 'cq-stock-name', ui.text.item(item)), r.have, r.day);
      return r;
    }, (r, { have, day }) => {
      r.have.textContent = ui.text.number(have);
      r.el.dataset.have = String(have);
      r.el.dataset.day = String(day);
      r.day.textContent = E.signed(day, Math.abs(day) < 10 && day % 1 ? 1 : 0);
      r.day.classList.toggle('bad', day < 0);
    });
    const drawEquip = keyed(equipList, (id) => {
      const r = { el: el('div', 'cq-equip') };
      r.el.dataset.tpl = id;
      r.name = el('span', 'cq-equip-name');
      r.name.dataset.userText = '';
      r.n = el('span', 'cq-can-equip');
      r.el.append(r.name, r.n);
      return r;
    }, (r, t) => {
      r.name.textContent = t.name;
      r.n.textContent = String(t.canEquip);
      r.el.dataset.canEquip = String(t.canEquip);
    });

    // ---------- resources and manpower ----------
    const resBody = E.section(root, tr('Resources'), 'cq-sec-res');
    const resHead = el('div', 'cq-res cq-res-head');
    for (const t of ['', tr('Domestic'), tr('Imported'), tr('Blockade'), tr('Sufficiency')]) resHead.append(el('span', null, t));
    const resList = el('div', 'cq-res-list');
    resBody.append(resHead, resList, el('div', 'cq-eco-note', tr('A line short of coal, iron or oil makes that much less: at 60% sufficiency it makes 60% of its output. Imports cover a shortfall only through open sea lanes, so a blockade cuts them.')));
    const drawRes = keyed(resList, (k) => {
      const r = { el: el('div', 'cq-res') };
      r.el.dataset.res = k;
      r.cells = [el('span', 'cq-res-name', ui.text.resource(k)), el('span'), el('span'), el('span'), el('span', 'cq-res-suff')];
      r.el.append(...r.cells);
      return r;
    }, (r, v) => {
      r.cells[1].textContent = ui.text.number(v.own);
      r.cells[2].textContent = ui.text.number(v.imported);
      r.cells[3].textContent = ui.text.percent(v.blockade);
      r.cells[4].textContent = v.demand ? ui.text.percent(v.suff) : tr('not needed');
      r.cells[4].classList.toggle('bad', v.suff < 700);
      r.cells[1].title = tr('{n} needed a day by the lines', { n: v.demand });
    });

    const manBody = E.section(root, tr('Manpower'), 'cq-sec-man');
    const man = { pool: el('span'), recruits: el('span'), training: el('span'), losses: el('span') };
    for (const [k, label] of [['pool', tr('Available')], ['recruits', tr('New recruits a day')], ['training', tr('In training')], ['losses', tr('Losses so far')]]) {
      const r = el('div', 'cq-eco-row');
      r.dataset.man = k;
      r.append(el('span', 'cq-eco-label', label), man[k]);
      manBody.append(r);
    }

    // ---------- construction ----------
    const buildBody = E.section(root, tr('Construction'), 'cq-sec-build');
    const buildBtns = el('div', 'cq-build-btns');
    const buildMsg = el('div', 'cq-eco-msg cq-build-msg');
    for (const what of ['mil', 'civ', 'infra']) {
      const b = el('button', 'cq-btn cq-build-pick', ui.text.building(what));
      b.dataset.what = what;
      b.title = tr('Pick a province on the map to build in');
      b.onclick = () => pickBuild(what);
      buildBtns.append(b);
    }
    const buildList = el('div', 'cq-build-list');
    buildBody.append(el('div', 'cq-eco-sub', tr('Build:')), buildBtns, buildMsg, buildList);
    const drawBuilds = keyed(buildList, (k) => {
      const r = { el: el('div', 'cq-build') };
      r.name = el('span', 'cq-build-name');
      r.meter = el('div', 'cq-bar-meter');
      r.fill = el('div', 'cq-bar-fill');
      r.meter.append(r.fill);
      r.days = el('span', 'cq-build-days');
      r.el.append(r.name, r.meter, r.days);
      return r;
    }, (r, b) => {
      r.el.dataset.what = b.what;
      r.el.dataset.province = String(b.prov);
      r.name.textContent = tr('{building} in {province}', { building: ui.text.building(b.what), province: game.map.provinces[b.prov]?.name || '?' });
      r.fill.style.width = `${Math.round((b.prog * 100) / b.cost)}%`;
      r.days.textContent = b.days === null ? tr('no civil factories') : tr('{d} days', { d: b.days });
    });
    async function pickBuild(what) {
      let info;
      try { info = await game.query('buildable', { what }); } catch (err) { buildMsg.textContent = ui.text.reason(err.message); return; }
      const ok = new Set(info.provinces);
      const level = new Map(info.levels);
      const days = info.perDay > 0 ? Math.ceil((info.ahead + info.cost) / info.perDay) : null;
      const p = await ui.pick.start({
        title: tr('Pick a province for a new {building}', { building: ui.text.building(what) }),
        legal: (id) => (ok.has(id) ? true : game.prov.owner[id] === game.player && game.prov.ctrl[id] === game.player ? 'at-cap' : 'bad-province'),
        describe: (id) => tr('{building} {from} → {to}: {cost} points, {days}', { building: ui.text.building(what), from: level.get(id), to: level.get(id) + 1, cost: info.cost,
          days: days === null ? tr('no civil factories') : tr('{d} days', { d: days }) }),
      });
      if (!p) return;
      const r = await game.order({ type: 'build', what, province: p });
      buildMsg.classList.toggle('bad', !r.ok);
      buildMsg.textContent = r.ok ? tr('{building} queued in {province}.', { building: ui.text.building(what), province: game.map.provinces[p].name }) : ui.text.reason(r.reason);
    }

    // ---------- training ----------
    const trainBody = E.section(root, tr('Training'), 'cq-sec-train');
    const trainForm = ui.train.form(trainBody);
    const trainList = el('div', 'cq-train-list');
    trainBody.append(trainList);
    const drawTraining = keyed(trainList, (id) => {
      const r = { el: el('div', 'cq-batch') };
      r.el.dataset.batch = String(id);
      r.name = el('span', 'cq-batch-name');
      r.name.dataset.userText = '';
      r.days = el('span', 'cq-batch-days');
      r.el.append(r.name, r.days);
      return r;
    }, (r, t) => {
      const tpl = game.me?.templates.find((x) => x.id === t.tpl);
      r.name.textContent = tr('{n} × {template} at {province}', { n: t.count, template: tpl?.name || t.tpl, province: game.map.provinces[t.at]?.name || '?' });
      const d = Math.ceil(t.hours / 24);
      r.days.textContent = tr('{d} days left', { d });
      r.el.dataset.days = String(d);
    });

    function render(d) {
      data = d;
      root.dataset.hour = String(game.hour);
      facLine.textContent = tr('{used} of {total} in use, {free} free', { used: d.used, total: d.mil, free: d.free });
      facLine.dataset.free = String(d.free);
      facFill.style.width = d.mil ? `${Math.round((d.used * 100) / d.mil)}%` : '0%';
      drawLines(d.lines.map((l) => [l.item, l]));
      const open = d.items.filter((it) => !it.line && !it.locked);
      const keep = newItem.value;
      newItem.replaceChildren(...open.map((it) => { const o = el('option', null, ui.text.item(it.id)); o.value = it.id; return o; }));
      if (open.some((it) => it.id === keep)) newItem.value = keep;
      newLine.hidden = !open.length;
      locked.replaceChildren(...d.items.filter((it) => it.locked).map((it) => {
        const r = el('div', 'cq-locked-item');
        r.dataset.item = it.id;
        const from = it.unlock.from ? ui.text.date({ y: +it.unlock.from.slice(0, 4), m: +it.unlock.from.slice(5, 7), d: +it.unlock.from.slice(8, 10) }) : '';
        const cond = from ? tr('from {date} with {mil} military factories', { date: from, mil: it.unlock.mil }) : tr('once {branch} are available', { branch: ui.text.branch(it.unlock.branch) });
        const start = el('button', 'cq-btn cq-locked-start', tr('Start Line'));
        start.disabled = true;
        start.title = cond;
        r.append(el('span', 'cq-locked-name', ui.text.item(it.id)), el('span', 'cq-locked-cond', cond), start);
        return r;
      }));
      drawStock(E.ITEMS.map((id) => [id, { have: d.stock[id] | 0, day: d.perDay[id] / 10 - (d.reinforce[id] | 0) }]));
      drawEquip(d.templates.map((t) => [t.id, t]));
      drawRes(['coal', 'iron', 'oil'].map((k) => [k, d.resources[k]]));
      man.pool.textContent = ui.text.number(d.manpower.pool);
      man.recruits.textContent = ui.text.number(d.manpower.recruits + d.manpower.draft);
      man.training.textContent = ui.text.number(d.manpower.training);
      man.losses.textContent = ui.text.number(d.manpower.casualties);
      drawBuilds(d.builds.map((b, i) => [`${i}:${b.what}:${b.prov}`, b]));
      drawTraining(d.training.map((t) => [t.id, t]));
      trainForm.update(d);
    }

    async function update() {
      const s = ++seq;
      let d;
      try { d = await game.query('economy'); } catch { return; }
      if (s === seq) render(d);
    }
    const off = game.on('tick', (t) => { if (t.me && !root.hidden) update(); });
    return { update, destroy: off, get data() { return data; } };
  }

  ui.panel({ id: 'production', title: tr('Production'), icon: 'package', order: 200, mount });
})();
