// The selection panel, above the minimap in the bottom-left corner of the map (ui.corner, ui/minimap.js): with
// divisions of the player's selected it lists them by army (count, mean organisation and strength) and offers what
// can be done to all of them through the existing orders: Halt (halt), Direct Control (halt on those the general
// still moves, which marks them manual), Give Back to the General (assign to their own army), a move to another army
// (assign) and New Army from Selection (army, then assign each), shown only when a `legal` query says the simulation
// takes an army order. A move is the right click on the map (ui/command.js). An action the simulation would refuse for
// every selected division (the `legal` query, asked for at most LEGAL_CAP of them when the selection or their state
// changes) is disabled with the reason in its tooltip and data-reason, not hidden.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;

  const LEGAL_CAP = 40;
  const mine = (id) => { const d = game.divs.get(id); return d && d.nation === game.player ? d : null; };
  const selected = () => game.selection.divisions.map(mine).filter(Boolean);
  const send = (order) => ui.command.send(order);

  let p = null;
  let legalSeq = 0;
  let signature = '';

  function build() {
    const box = el('div', 'cq-selpanel');
    box.hidden = true;
    box.setAttribute('role', 'region');
    const head = el('div', 'cq-sel-head');
    const title = el('div', 'cq-sel-title');
    const close = el('button', 'cq-icon-btn cq-sel-close');
    close.append(ide.icon('closeSmall'));
    close.title = ide.keymap.withKeys(tr('Clear the Selection'), 'Conquest.ClearSelection');
    close.onclick = () => game.setSelection({ divisions: [] });
    head.append(title, close);
    box.setAttribute('aria-label', tr('Selected Divisions'));
    const list = el('div', 'cq-sel-armies');
    const hint = el('div', 'cq-sel-hint', tr('Right-click a province to send them there.'));
    const actions = el('div', 'cq-sel-actions');
    const button = (cls, label, tip, run) => { const b = el('button', `cq-btn ${cls}`, label); b.dataset.tip = tip; b.title = tip; b.onclick = run; return b; };
    const halt = button('cq-halt', tr('Halt'), tr('Stop where they are. The general does not move them again while they are under your direct control.'), () => Promise.all(selected().map((d) => send({ type: 'halt', div: d.id }))));
    const direct = button('cq-direct', tr('Direct Control'), tr('Take direct control: the general no longer moves them. Right-click a province to send them there.'),
      () => Promise.all(selected().filter((d) => !d.manual).map((d) => send({ type: 'halt', div: d.id }))));
    const giveBack = button('cq-give-back', tr('Give Back to the General'), tr("Hand them back to their army's general."),
      () => Promise.all(selected().filter((d) => d.manual && d.army !== null && d.army !== undefined).map((d) => send({ type: 'assign', div: d.id, army: d.army }))));
    const moveTo = document.createElement('select');
    moveTo.className = 'cq-select cq-move-army';
    moveTo.title = tr('Move to another army');
    moveTo.onchange = () => {
      const army = Number(moveTo.value);
      moveTo.value = '';
      if (army > 0) Promise.all(selected().map((d) => send({ type: 'assign', div: d.id, army })));
    };
    const newArmy = button('cq-new-army-sel', tr('New Army from Selection'), tr('Form a new army of these divisions.'), () => {
      const ids = selected().map((d) => d.id);
      ui.command.askArmyName(async (army) => {
        await Promise.all(ids.map((div) => send({ type: 'assign', div, army })));
        game.setSelection({ army, divisions: ids });
      });
    });
    newArmy.hidden = true;
    actions.append(halt, direct, giveBack, moveTo, newArmy);
    box.append(head, list, hint, actions);
    ui.corner().prepend(box);
    p = { box, title, list, halt, direct, giveBack, moveTo, newArmy };
  }

  const mean = (divs, key) => divs.reduce((s, d) => s + d[key], 0) / Math.max(1, divs.length);
  function render() {
    if (!p) return;
    const sel = game.running ? selected() : [];
    p.box.hidden = !sel.length;
    p.box.dataset.count = String(sel.length);
    if (!sel.length) { signature = ''; ui.command?.fitCard(); return; }
    p.title.textContent = sel.length === 1 ? tr('1 division selected') : tr('{n} divisions selected', { n: sel.length });
    const byArmy = new Map();
    for (const d of sel) { const k = d.army ?? null; if (!byArmy.has(k)) byArmy.set(k, []); byArmy.get(k).push(d); }
    const rows = [];
    for (const [army, divs] of byArmy) {
      const row = el('div', 'cq-sel-army');
      row.dataset.army = army === null ? '' : String(army);
      row.dataset.count = String(divs.length);
      const a = army === null ? null : game.me?.armies.find((x) => x.id === army);
      const name = el('span', 'cq-sel-army-name', a ? a.name : tr('In no army'));
      if (a) { name.dataset.userText = ''; row.style.setProperty('--cq-army-color', ui.armyColor(army)); }
      row.append(name, el('span', 'cq-sel-army-stat', tr('{n} div.', { n: divs.length })),
        el('span', 'cq-sel-army-stat', tr('org {org}', { org: ui.text.percent(mean(divs, 'org')) })),
        el('span', 'cq-sel-army-stat', tr('str {str}', { str: ui.text.percent(mean(divs, 'str')) })));
      rows.push(row);
    }
    p.list.replaceChildren(...rows);
    // The army list is rebuilt only when it changes, so an open drop-down is not closed under the pointer.
    const armies = game.me?.armies || [];
    const names = armies.map((a) => `${a.id}:${a.name}`).join('|');
    if (p.moveTo.dataset.armies !== names) {
      const opts = [el('option', null, tr('Move to army…'))];
      opts[0].value = '';
      for (const a of armies) { const o = el('option', null, a.name); o.value = String(a.id); opts.push(o); }
      p.moveTo.replaceChildren(...opts);
      p.moveTo.value = '';
      p.moveTo.dataset.armies = names;
    }
    p.moveTo.disabled = !armies.length;
    const sig = sel.map((d) => `${d.id}:${d.manual ? 1 : 0}:${d.army}:${d.prov}`).join();
    if (sig !== signature) { signature = sig; checkLegal(sel); }
    ui.command?.fitCard();
  }

  const setWhy = (b, why) => {
    b.disabled = !!why;
    b.dataset.reason = why || '';
    b.title = why || b.dataset.tip;
  };
  async function checkLegal(sel) {
    const seq = ++legalSeq;
    const some = sel.slice(0, LEGAL_CAP);
    const ask = (order) => game.query('legal', { order }).catch(() => ({ ok: false, reason: 'bad-order' }));
    const refusal = (rs) => (rs.some((r) => r.ok) ? null : ui.text.reason(rs[0]?.reason));
    const free = some.filter((d) => !d.manual);
    const back = some.filter((d) => d.manual && d.army !== null && d.army !== undefined);
    const [halts, frees, backs, army] = await Promise.all([
      Promise.all(some.map((d) => ask({ type: 'halt', div: d.id }))),
      Promise.all(free.map((d) => ask({ type: 'halt', div: d.id }))),
      Promise.all(back.map((d) => ask({ type: 'assign', div: d.id, army: d.army }))),
      ask({ type: 'army', name: tr('New Army'), general: null }),
    ]);
    if (seq !== legalSeq || !p) return;
    setWhy(p.halt, refusal(halts));
    setWhy(p.direct, !free.length ? tr('All of them are under your direct control already.') : refusal(frees));
    setWhy(p.giveBack, !some.some((d) => d.manual) ? tr('None of them is under your direct control.')
      : !back.length ? tr('They are in no army: move them to an army instead.') : refusal(backs));
    p.newArmy.hidden = army.reason === 'unknown-order' || army.reason === 'bad-order';
    setWhy(p.newArmy, army.ok ? null : ui.text.reason(army.reason));
    p.box.dataset.checked = String(seq);
  }

  ui.events.on('game', () => { if (!p) build(); signature = ''; render(); });
  ui.events.on('start', () => render());
  game.on('select', () => render());
  game.on('ordered', () => render());
  game.on('tick', (d) => { if ((d.divs || d.me) && game.selection.divisions.length) render(); });

  ui.selPanel = { render, get element() { return p?.box || null; } };
})();
