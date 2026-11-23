// Selection and command, the heart of play: the province card, the army bar and every order the player gives on the
// map. A left click selects the province under it, or the stack of divisions when it lands on a counter (one of the
// player's selects their army and those divisions; with Shift it adds them); a click on land with no counter clears the
// divisions. The box and the double click are ui/selectbox.js, what can be done to the selection ui/selpanel.js. With
// an army selected: Draw Front and Draw Offensive turn left clicks and drags into a chain of provinces (gaps between
// two clicks are filled with the shortest land path; Backspace drops the last, Enter confirms, Esc cancels). While
// drawing, the plan under the pointer is previewed (a front on the real border edges it will hold against the enemy,
// an offensive as an arrow from the army through the provinces it will cross), a hint over the map says what a click,
// Enter and Esc do, and an offensive shows the `attackOdds` query for its first province. Launch/Stop and Clear Front;
// a launch and a move are confirmed by a flash at their target. With divisions of the player's selected, hovering a
// province previews their routes (the `route` query for up to ROUTE_FROM of their provinces, ROUTE_DEBOUNCE_MS after
// the pointer stops on it, dropped when it moves on): an arrow per route and a tag at the target with the latest arrival,
// green when the move is legal and red with the reason when not; a right click sends them all there. The orders have
// no waypoints, so Shift+right-click is the same right click. New Army ({ type: 'army', name, general }) and Disband
// Army ({ type: 'army', army, disband: true }) and removing an offensive ({ type: 'offensive', army, offensive, path:
// null }) appear only when a `legal` query says the simulation takes them. A refused order shows its translated reason
// next to the pointer. The card sits at the top left of the map (an open panel docks beside the map, never over the
// card), ends above the bottom-left corner (selection panel and minimap) and folds to its name; its division list
// draws only the rows in view, so a province with a hundred divisions costs a screenful of rows. The army bar has Staff
// Front (the selected army) and Replan All Fronts, which ask the staff (ui/eco-staff.js). Its army cards keep one row
// at their full width (no text is cut) and say when the army fights, is short of supply or rests; when they do not
// fit, the row scrolls with the wheel and with arrow buttons at both ends and snaps to a card's edge, and the selected
// army is kept in view. A click on a card selects the army, a double click also centres the map on it; Tab and
// Shift+Tab step through the armies.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;

  const MAX_GAP = 60;
  const ROUTE_DEBOUNCE_MS = 90;
  const ROUTE_FROM = 6;
  const DRAW_MS = 50;
  const FLASH_MS = 1600;
  const PREVIEW = '#ffffff';
  const LEGAL = '#8fe08a';
  const REFUSED = '#ff6a5a';
  const LOW_SUP = 500;
  const READY_ORG = 650;
  const PAD_X = 6;

  let pointer = null;
  let draw = null; // { kind: 'front' | 'offensive', army, chain: [province] }
  let armyOrder = false;
  let removeOrder = false;
  let removeProbed = false; // asked once an army has an offensive to ask about
  const offs = [];

  const view = () => shell.view;
  const bind = () => shell.bind;
  const mine = (id) => { const d = game.divs.get(id); return d && d.nation === game.player ? d : null; };
  const armyOf = (id) => game.me?.armies.find((a) => a.id === id) || null;
  const traitOf = (general) => (game.scenario.nations[game.player]?.generals || []).find((g) => g.name === general)?.trait || null;

  async function send(order, at = pointer) {
    const r = await game.order(order);
    if (!r.ok) shell.toast(ui.text.reason(r.reason), at);
    return r;
  }

  // ---------- the province card ----------
  let card = null;
  function buildCard() {
    const box = el('div', 'cq-card');
    box.hidden = true;
    const head = el('div', 'cq-card-head');
    const name = el('div', 'cq-card-name');
    name.dataset.userText = '';
    const close = el('button', 'cq-icon-btn cq-card-close');
    close.append(ide.icon('closeSmall'));
    close.title = tr('Close');
    close.onclick = () => { game.setSelection({ province: 0 }); view()?.setSelected(0); };
    const fold = el('button', 'cq-icon-btn cq-card-fold');
    fold.append(ide.icon('chevronDown'));
    fold.title = tr('Fold the Card');
    fold.onclick = () => {
      const on = !card.box.classList.contains('folded');
      card.box.classList.toggle('folded', on);
      fold.title = on ? tr('Unfold the Card') : tr('Fold the Card');
      fitCard();
    };
    head.append(name, fold, close);
    const facts = el('div', 'cq-card-facts');
    const detail = el('div', 'cq-div-detail-host');
    detail.hidden = true;
    const divs = el('div', 'cq-card-divs');
    const rowsBox = el('div', 'cq-card-rows');
    divs.append(rowsBox);
    divs.onscroll = () => drawRows();
    box.append(head, facts, divs, detail);
    shell.stage.append(box);
    card = { box, name, facts, detail, divs, rowsBox, id: 0, seq: 0, items: [] };
    ide.util.observeSize(shell.stage, () => fitCard());
  }

  // The card ends above the bottom-left corner of the map (ui/minimap.js's corner: the selection panel and minimap).
  function fitCard() {
    if (!card || card.box.hidden) return;
    const corner = shell.corner && !shell.corner.hidden ? shell.corner.offsetHeight + 10 : 0;
    card.box.style.maxHeight = `${Math.max(120, shell.stage.clientHeight - 20 - corner)}px`;
    drawRows();
  }

  // The division list: a header per nation and a row per division, ROW_H pixels each; only those in view are made.
  const ROW_H = 22;
  function drawRows() {
    if (!card) return;
    const items = card.items;
    const box = card.divs;
    card.rowsBox.style.height = `${items.length * ROW_H}px`;
    const top = box.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - 3);
    const last = Math.min(items.length, Math.ceil((top + (box.clientHeight || 240)) / ROW_H) + 3);
    const out = [];
    for (let i = first; i < last; i++) {
      const it = items[i];
      const node = it.nation !== undefined ? el('div', 'cq-card-nation', it.text) : divRow(it.d, it.n);
      node.style.transform = `translateY(${i * ROW_H}px)`;
      out.push(node);
    }
    card.rowsBox.replaceChildren(...out);
  }
  function divRow(d, n) {
    const row = el('div', 'cq-div-row');
    row.dataset.div = String(d.id);
    const sel = game.selection.divisions.includes(d.id);
    row.classList.toggle('selected', sel);
    const nameText = d.armyName ? `${d.tplName} · ${d.armyName}` : d.tplName;
    const dn = el('span', 'cq-div-name', nameText);
    dn.dataset.userText = '';
    row.append(dn, el('span', 'cq-div-stat', tr('str {str}', { str: ui.text.percent(d.str) })), el('span', 'cq-div-stat', tr('org {org}', { org: ui.text.percent(d.org) })));
    if (d.manual) row.append(el('span', 'cq-div-tag', tr('direct')));
    if (card.line?.has(d.id)) { row.classList.add('in-line'); row.append(el('span', 'cq-div-tag cq-div-line', tr('in the line'))); }
    if (n === game.player) row.classList.add('own');
    row.onclick = (e) => {
      if (!(e.ctrlKey || e.shiftKey)) ui.divDetail?.show(d.id, card.detail);
      if (n !== game.player) return;
      const divs = e.ctrlKey || e.shiftKey ? (sel ? game.selection.divisions.filter((x) => x !== d.id) : [...game.selection.divisions, d.id]) : [d.id];
      game.setSelection({ divisions: divs, army: d.army ?? game.selection.army });
    };
    return row;
  }
  // Scrolls the list so a division's row is in view (tests and the guide reach a row this way).
  function revealDivision(id) {
    const i = card?.items.findIndex((it) => it.d?.id === id) ?? -1;
    if (i < 0) return false;
    const box = card.divs;
    if (i * ROW_H < box.scrollTop || (i + 1) * ROW_H > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, i * ROW_H - box.clientHeight / 2);
    drawRows();
    return true;
  }

  // A fact with an explanation: a string is its title; { key, note, rows } shows the shared tooltip (ui/tip.js) on
  // hover and focus, its note also kept in data-note.
  const fact = (label, value, explain) => {
    const row = el('div', 'cq-fact');
    row.append(el('span', 'cq-fact-label', label), el('span', 'cq-fact-value', value));
    if (typeof explain === 'string') row.title = explain;
    else if (explain) {
      row.dataset.note = explain.note;
      row.dataset.tip = explain.key;
      const build = () => ({ title: label, rows: explain.rows || [], note: explain.note, key: `fact-${explain.key}` });
      ui.tip.attach(row, build, { focus: false });
      ui.tip.attach(row.children[1], build, { hover: false });
    }
    return row;
  };
  const trenches = (p) => fact(tr('Trenches'), p.dug ? tr('Dug in ({works})', { works: p.works }) : tr('Shallow ({works} of {need})', { works: p.works, need: p.trench }), {
    key: 'trenches', rows: [['works', tr('Works'), String(p.works), p.works], ['need', tr('Dug in from'), String(p.trench), p.trench]],
    note: `${tr('Until the trenches reach {need}, attackers who win a battle here take the province within the hour.', { need: p.trench })} ${tr('Divisions that stay here dig in further; the trenches add to their defence, less the siege of the attacking artillery.')}` });
  const supplyFact = (p) => fact(tr('Supply'), String(p.supply), {
    key: 'supply', rows: [['supply', tr('Reaching this province'), String(p.supply), p.supply], ['capital', tr('At the capital'), String(game.rules.supply.capital), game.rules.supply.capital]],
    note: tr('The divisions here share it by their supply use. With enough they regain organisation; short of it they lose organisation, and in battle a division with no supply fights at {pct} of its power.', { pct: ui.text.percent(game.rules.supply.outOfSupply) }) });
  const infraFact = (p) => fact(tr('Infrastructure'), String(p.infra), {
    key: 'infra', rows: [['infra', tr('Level'), String(p.infra), p.infra]],
    note: tr('Roads and railways: each level makes the way into this province faster, much more so behind your own lines, and supply loses less passing through it.') });

  async function showCard() {
    const id = game.selection.province;
    if (!card || !game.running) return;
    if (!id) { card.box.hidden = true; card.id = 0; return; }
    const seq = ++card.seq;
    let p;
    try { p = await game.query('province', { id }); } catch { return; }
    if (seq !== card.seq) return;
    card.id = id;
    card.box.hidden = false;
    card.box.dataset.province = String(id);
    card.name.textContent = p.name;
    const rows = [];
    if (p.sea) {
      rows.push(fact(tr('Sea control'), p.ctrl >= 0 ? game.nationName(p.ctrl) : p.ctrl === -2 ? tr('Contested') : tr('Nobody')));
    } else {
      rows.push(fact(tr('Owner'), p.owner >= 0 ? game.nationName(p.owner) : tr('None')));
      if (p.ctrl !== p.owner) rows.push(fact(tr('Held by'), p.ctrl >= 0 ? game.nationName(p.ctrl) : tr('None')));
      rows.push(fact(tr('Terrain'), ui.text.terrain(p.terrain)), fact(tr('Climate'), ui.text.climate(p.climate)), fact(tr('Weather'), ui.text.weather(p.weather)));
      rows.push(infraFact(p), fact(tr('Factories'), tr('{mil} military, {civ} civil', { mil: p.mil, civ: p.civ })));
      rows.push(fact(tr('Resources'), tr('coal {coal}, iron {iron}, oil {oil}', { coal: p.coal, iron: p.iron, oil: p.oil })), supplyFact(p));
      if (p.cores.length) rows.push(fact(tr('Core of'), p.cores.map((n) => game.nationName(n)).join(', ')));
      rows.push(trenches(p));
      if (p.battle) {
        const standing = p.battle.line.filter((id) => p.divisions.some((d) => d.id === id)).length;
        const b = fact(tr('Battle'), tr('{nation} attacks, {odds} an hour; {n} of {max} divisions in the defending line', { nation: game.nationName(p.battle.side), odds: ui.text.percent(p.battle.odds), n: standing, max: p.battle.lineMax }),
          tr('At most {max} divisions hold a province at a time; when they break, the rest fall back. Click for the battle.', { max: p.battle.lineMax }));
        b.classList.add('link', 'cq-fact-battle');
        const v = b.children[1];
        v.setAttribute('role', 'button');
        v.tabIndex = 0;
        b.onclick = () => ui.battle?.open(p.id);
        v.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); ui.battle?.open(p.id); } };
        rows.push(b);
      }
    }
    card.line = new Set(p.battle ? p.battle.line : []);
    if (ui.tip.anchor && card.facts.contains(ui.tip.anchor)) ui.tip.hide();
    card.facts.replaceChildren(...rows);
    if (card.shownFor !== id) ui.divDetail?.close(card.detail);
    card.facts.dataset.owner = String(p.owner);
    card.facts.dataset.ctrl = String(p.ctrl);
    const byNation = new Map();
    for (const d of p.divisions) { if (!byNation.has(d.nation)) byNation.set(d.nation, []); byNation.get(d.nation).push(d); }
    const items = [];
    for (const [n, list] of byNation) {
      items.push({ nation: n, text: tr('{nation}: {count} divisions', { nation: game.nationName(n), count: list.length }) });
      for (const d of list) items.push({ d, n });
    }
    const changed = card.items.length !== items.length || card.shownFor !== id;
    card.items = items;
    card.shownFor = id;
    card.divs.hidden = !items.length;
    if (changed) card.divs.scrollTop = 0;
    card.box.dataset.divisions = String(p.divisions.length);
    fitCard();
  }

  // ---------- the army bar ----------
  let bar = null;
  function buildBar() {
    const root = shell.armybar;
    const strip = el('div', 'cq-army-strip');
    const list = el('div', 'cq-army-list');
    const arrow = (cls, dir, label) => {
      const b = el('button', `cq-icon-btn cq-army-scroll ${cls}`);
      b.append(ide.icon('chevronDown'));
      b.title = label;
      b.setAttribute('aria-label', label);
      b.onclick = () => stepScroll(dir);
      return b;
    };
    const prev = arrow('cq-army-prev', -1, tr('Earlier Armies'));
    const next = arrow('cq-army-next', 1, tr('Later Armies'));
    strip.append(prev, list, next);
    list.addEventListener('wheel', (e) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    }, { passive: false });
    list.addEventListener('scroll', () => showArrows());
    ide.util.observeSize(list, () => showArrows());
    const cmds = el('div', 'cq-commands');
    const planLabel = el('div', 'cq-plan-label');
    const btn = (cls, label, run, title) => { const b = el('button', `cq-btn ${cls}`, label); b.onclick = run; if (title) b.title = title; return b; };
    const front = btn('cq-draw-front', tr('Draw Front'), () => startDraw('front'), tr('Click or drag across the provinces the army should hold. Enter confirms, Esc cancels.'));
    const offensive = btn('cq-draw-offensive', tr('Draw Offensive'), () => startDraw('offensive'), tr('Click the path from the front toward the objective. Enter confirms, Esc cancels.'));
    const clear = btn('cq-clear-front', tr('Clear Front'), () => { const a = game.selection.army; if (a !== null) send({ type: 'front', army: a, provinces: null }); });
    const offs2 = el('div', 'cq-offensives');
    const offsBtn = el('button', 'cq-btn cq-offs-btn');
    offsBtn.setAttribute('aria-haspopup', 'true');
    offsBtn.onclick = (e) => { e.stopPropagation(); setOffsOpen(!offsOpen); };
    offs2.append(offsBtn);
    const offsPop = el('div', 'cq-offs-pop');
    offsPop.hidden = true;
    offsPop.setAttribute('role', 'dialog');
    const offsList = el('div', 'cq-offs-list');
    const offsClear = el('button', 'cq-btn cq-offs-clear');
    offsClear.onclick = () => clearFinished();
    offsPop.append(offsList, offsClear);
    offsPop.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', (e) => { if (offsOpen && !offs2.contains(e.target) && !offsPop.contains(e.target)) setOffsOpen(false); }, true);
    const confirm = btn('primary cq-draw-confirm', tr('Confirm Plan'), () => finishDraw(), ide.keymap.withKeys(tr('Confirm Plan'), 'Conquest.ConfirmPlan'));
    const cancel = btn('cq-draw-cancel', tr('Cancel'), () => cancelDraw(), ide.keymap.withKeys(tr('Cancel'), 'Conquest.CancelPlan'));
    const drawHint = el('span', 'cq-draw-hint');
    const staff = btn('cq-staff-front', tr('Staff Front'), () => { const a = game.selection.army; if (a !== null) ui.staff?.assign([a], { force: true }); },
      tr("Let the staff choose this army's front: its share of the border, by the threat there."));
    const replan = btn('cq-replan', tr('Replan All Fronts'), () => ui.staff?.replanAll(), tr('The staff sets the fronts of every army whose front you did not draw yourself.'));
    const newArmy = btn('cq-new-army', tr('New Army'), () => askArmyName(null));
    const disband = btn('cq-disband-army', tr('Disband Army'), () => askDisband());
    newArmy.hidden = true;
    disband.hidden = true;
    cmds.append(planLabel, front, offensive, staff, clear, offs2, drawHint, confirm, cancel, el('span', 'cq-gap'), replan, disband, newArmy);
    root.append(cmds, strip, offsPop);
    bar = { list, prev, next, cmds, planLabel, front, offensive, clear, offs: offs2, offsBtn, offsPop, offsList, offsClear, confirm, cancel, drawHint, newArmy, disband, staff, replan };
  }

  const avg = (ids, key) => {
    let s = 0;
    let n = 0;
    for (const id of ids) { const d = game.divs.get(id); if (d) { s += d[key]; n++; } }
    return n ? s / n : 0;
  };
  const planState = (a) => {
    const on = (a.offensives || []).filter((o) => o.on).length;
    if (on) return tr('Attacking');
    if ((a.offensives || []).length) return tr('Offensive planned');
    if (a.front && ui.staff?.isReserve(a.id)) return tr('In reserve near the capital');
    if (a.front) return ui.staff?.isStaff(a.id) ? tr('Staff front of {n} provinces', { n: a.front.length }) : tr('Holding a front of {n} provinces', { n: a.front.length });
    return tr('No plan');
  };

  function renderArmies() {
    if (!bar) return;
    const armies = game.me?.armies || [];
    const sel = game.selection.army;
    const cards = armies.map((a) => {
      const c = el('button', 'cq-army');
      c.dataset.army = String(a.id);
      c.classList.toggle('active', a.id === sel);
      c.style.setProperty('--cq-army-color', ui.armyColor?.(a.id) || 'transparent');
      const trait = traitOf(a.general);
      const general = a.general ? (trait ? `${a.general} · ${ui.text.trait(trait)}` : a.general) : tr('No general');
      const stats = el('div', 'cq-army-stats');
      const stat = (key, text, title, note) => {
        const s = el('span', `cq-army-stat cq-army-${key}`, text);
        s.dataset.k = key;
        ui.tip.attach(s, () => ({ title, note, key: `army-${key}` }), { focus: false });
        return s;
      };
      stats.append(el('span', null, tr('{n} div.', { n: a.divs.length })),
        stat('str', tr('str {str}', { str: ui.text.percent(avg(a.divs, 'str')) }), tr('Mean strength'),
          tr('The share of men and equipment the divisions have. Attack and defence scale with it; reinforcement refills it from manpower and stock.')),
        stat('org', tr('org {org}', { org: ui.text.percent(avg(a.divs, 'org')) }), tr('Mean organisation'),
          tr('How long the divisions keep fighting. Each lost hour of battle takes some; at 0 a division breaks and falls back. It returns out of battle while supplied.')),
        stat('sup', tr('sup {sup}', { sup: ui.text.percent(avg(a.divs, 'sup')) }), tr('Mean supply'),
          tr('The share of their supply use the divisions get. Short of it they lose organisation; with none they fight at {pct} of their power.', { pct: ui.text.percent(game.rules.supply.outOfSupply) })));
      const an = el('div', 'cq-army-name', a.name);
      const ag = el('div', 'cq-army-general', general);
      an.dataset.userText = '';
      ag.dataset.userText = '';
      const plan = el('div', 'cq-army-plan');
      const tags = statusOf(a).map(([k, text, note]) => { const t = el('span', `cq-army-tag cq-army-tag-${k}`, text); t.dataset.k = k; t.title = note; return t; });
      plan.append(el('span', 'cq-army-plan-text', planState(a)), ...tags);
      c.append(an, ag, stats, plan);
      c.dataset.status = tags.map((t) => t.dataset.k).join(' ');
      c.title = ide.keymap.withKeys(tr('Click selects the army; a double click also centres the map on it'), 'Conquest.NextArmy');
      c.onclick = (e) => (e.detail > 1 ? centreArmy(a.id) : selectArmy(a.id));
      return c;
    });
    if (ui.tip.anchor && bar.list.contains(ui.tip.anchor)) ui.tip.hide();
    bar.list.replaceChildren(...cards);
    revealArmy();
    showArrows();
    renderCommands();
  }
  // What the army's card says beside its plan: in battle, short of supply, resting (organisation below what its
  // general waits for before it attacks again, mil-common.js's ready).
  function statusOf(a) {
    const ids = new Set(a.divs);
    const out = [];
    if (game.battles.some((b) => b.att?.some((id) => ids.has(id)) || b.def?.some((id) => ids.has(id)))) out.push(['battle', tr('In battle'), tr('Some of its divisions are fighting a battle.')]);
    if (a.divs.length && avg(a.divs, 'sup') < LOW_SUP) out.push(['supply', tr('Short of supply'), tr('Its divisions get less than half the supply they use and lose organisation.')]);
    if (!out.length && a.divs.length && avg(a.divs, 'org') < READY_ORG) out.push(['rest', tr('Resting'), tr('Its organisation is low; out of battle and supplied it comes back.')]);
    return out;
  }
  // The arrows scroll the row to the next card's edge (the row snaps to card edges too, style.css).
  function stepScroll(dir) {
    const l = bar.list;
    const cards = [...l.children];
    const left = l.scrollLeft;
    const target = dir > 0 ? cards.find((c) => c.offsetLeft - l.firstElementChild.offsetLeft > left + 1 && c.offsetLeft + c.offsetWidth > left + l.clientWidth)
      : [...cards].reverse().find((c) => c.offsetLeft - l.firstElementChild.offsetLeft < left - 1);
    if (!target) return;
    const x = target.offsetLeft - l.firstElementChild.offsetLeft;
    l.scrollTo({ left: Math.max(0, Math.min(x, l.scrollWidth - l.clientWidth)), behavior: 'smooth' });
  }
  // Scrolls the army row so the selected army's card is wholly in view.
  function revealArmy() {
    const c = bar.list.querySelector('.cq-army.active');
    if (!c) return;
    const l = bar.list;
    if (c.offsetLeft < l.scrollLeft) l.scrollLeft = c.offsetLeft - 4;
    else if (c.offsetLeft + c.offsetWidth > l.scrollLeft + l.clientWidth) l.scrollLeft = c.offsetLeft + c.offsetWidth - l.clientWidth + 4;
  }
  function showArrows() {
    if (!bar) return;
    const l = bar.list;
    const first = l.firstElementChild;
    const last = l.lastElementChild;
    const over = !!first && last.offsetLeft + last.offsetWidth - first.offsetLeft + 2 * PAD_X > l.clientWidth + 1;
    // Room after the last card, so the row's furthest scroll also starts at a card's edge (no card cut at the left).
    const room = over ? `${Math.max(PAD_X, l.clientWidth - last.offsetWidth - PAD_X)}px` : '';
    if (l.style.paddingRight !== room) l.style.paddingRight = room;
    bar.prev.hidden = !over;
    bar.next.hidden = !over;
    bar.prev.disabled = l.scrollLeft <= 0;
    bar.next.disabled = l.scrollLeft + l.clientWidth >= l.scrollWidth - 1;
  }

  function renderCommands() {
    if (!bar) return;
    const a = armyOf(game.selection.army);
    const drawing = !!draw;
    bar.cmds.classList.toggle('drawing', drawing);
    bar.planLabel.textContent = a ? a.name : tr('Select an army to plan its front and offensives.');
    if (a) bar.planLabel.dataset.userText = ''; else delete bar.planLabel.dataset.userText;
    for (const b of [bar.front, bar.offensive, bar.clear, bar.staff]) b.hidden = !a || drawing;
    bar.staff.hidden = bar.staff.hidden || !ui.staff;
    bar.replan.hidden = drawing || !ui.staff || !(game.me?.armies || []).length;
    bar.clear.disabled = !a?.front;
    bar.front.classList.toggle('active', draw?.kind === 'front');
    bar.confirm.hidden = !drawing;
    bar.cancel.hidden = !drawing;
    bar.drawHint.hidden = !drawing;
    if (drawing) bar.drawHint.textContent = draw.kind === 'front' ? tr('Front: {n} provinces', { n: draw.chain.length }) : tr('Offensive: {n} provinces', { n: draw.chain.length });
    bar.newArmy.hidden = !armyOrder || drawing;
    bar.disband.hidden = !armyOrder || !a || drawing;
    renderOffensives(a && !drawing ? a : null);
  }

  // The selected army's offensives sit behind one button (their count; the list opens above it), so the command row
  // stays one line however many there are. An entry has its objective, its state (planned, attacking, stopped,
  // objective taken) and Launch or Stop and Remove; Remove Finished clears the stopped and the taken ones. Entries are
  // updated in place: the list is redrawn while the game runs, and a button rebuilt under the pointer loses the click.
  let offsOpen = false;
  let openWhenListed = null; // a just-planned offensive: the list opens once the army carries it
  const offEls = new Map(); // offensive id -> { row, name, state, go, rm }
  const wasOn = new Set(); // offensives seen attacking this session; off again, they read as stopped
  const goalOf = (o) => o.path[o.path.length - 1];
  const offState = (o) => (o.on ? 'on' : game.prov.ctrl[goalOf(o)] === game.player ? 'taken' : wasOn.has(o.id) ? 'stopped' : 'planned');
  const OFF_STATES = { on: () => tr('Attacking'), taken: () => tr('Objective taken'), stopped: () => tr('Stopped, not attacking'), planned: () => tr('Not launched yet') };
  function setOffsOpen(open) {
    offsOpen = !!open && !bar.offs.hidden;
    bar.offsPop.hidden = !offsOpen;
    bar.offsBtn.setAttribute('aria-expanded', String(offsOpen));
    if (offsOpen) placeOffsPop();
  }
  function placeOffsPop() {
    const b = bar.offsBtn.getBoundingClientRect();
    const host = bar.offsPop.offsetParent?.getBoundingClientRect() || { left: 0, top: 0, width: innerWidth };
    bar.offsPop.style.left = `${Math.max(4, Math.min(b.left - host.left, host.width - bar.offsPop.offsetWidth - 4))}px`;
    bar.offsPop.style.bottom = `${host.top + (bar.offsPop.offsetParent?.clientHeight || 0) - (b.top - 4)}px`;
  }
  function renderOffensives(a) {
    const list = a ? a.offensives || [] : [];
    for (const o of list) if (o.on) wasOn.add(o.id);
    bar.offs.hidden = !list.length;
    if (!list.length) { setOffsOpen(false); return; }
    if (!removeProbed) { removeProbed = true; probeOrders(a); }
    if (openWhenListed !== null && (openWhenListed === true || list.some((o) => o.id === openWhenListed))) { openWhenListed = null; offsOpen = true; }
    const on = list.filter((o) => o.on).length;
    bar.offsBtn.textContent = on ? tr('Offensives: {n}, {on} attacking', { n: list.length, on }) : tr('Offensives: {n}', { n: list.length });
    bar.offsBtn.classList.toggle('on', on > 0);
    bar.offsBtn.title = tr('Show the offensives of {army}', { army: a.name });
    const rows = list.map((o, i) => {
      let e = offEls.get(o.id);
      if (!e) {
        const row = el('div', 'cq-off');
        row.dataset.offensive = String(o.id);
        const name = el('span', 'cq-off-name');
        const state = el('span', 'cq-off-state');
        const go = el('button', 'cq-btn cq-launch');
        const rm = el('button', 'cq-icon-btn cq-off-remove');
        rm.append(ide.icon('closeSmall'));
        rm.title = tr('Remove Offensive');
        rm.setAttribute('aria-label', rm.title);
        row.append(name, state, go, rm);
        e = { row, name, state, go, rm };
        offEls.set(o.id, e);
      }
      const st = offState(o);
      e.row.classList.toggle('on', o.on);
      e.row.dataset.state = st;
      e.name.textContent = tr('Offensive {n}: {goal}', { n: i + 1, goal: game.map.provinces[goalOf(o)]?.name || '?' });
      e.state.textContent = OFF_STATES[st]();
      e.go.textContent = o.on ? tr('Stop Offensive') : tr('Launch Offensive');
      e.go.classList.toggle('primary', !o.on);
      e.go.onclick = async () => {
        const r = await send({ type: 'launch', army: a.id, offensive: o.id, on: !o.on });
        if (r.ok) flash(goalOf(o), o.on ? tr('Offensive stopped') : tr('Offensive launched'));
      };
      e.rm.hidden = !removeOrder;
      e.rm.onclick = () => send({ type: 'offensive', army: a.id, offensive: o.id, path: null });
      return e.row;
    });
    const ids = new Set(list.map((o) => o.id));
    for (const id of offEls.keys()) if (!ids.has(id)) offEls.delete(id);
    const box = bar.offsList;
    if (rows.length !== box.children.length || rows.some((r, i) => box.children[i] !== r)) box.replaceChildren(...rows);
    const done = list.filter((o) => !o.on && offState(o) !== 'planned').length;
    bar.offsClear.hidden = !done || !removeOrder;
    bar.offsClear.textContent = tr('Remove Finished ({n})', { n: done });
    setOffsOpen(offsOpen);
  }
  async function clearFinished() {
    const a = armyOf(game.selection.army);
    if (!a) return;
    for (const o of (a.offensives || []).filter((x) => !x.on && offState(x) !== 'planned')) await send({ type: 'offensive', army: a.id, offensive: o.id, path: null });
  }

  function selectArmy(id) {
    if (draw) cancelDraw();
    if (game.selection.army !== id) setOffsOpen(false);
    const a = armyOf(id);
    const same = game.selection.army === id;
    game.setSelection({ army: same ? null : id, divisions: [] });
    probeOrders(a);
  }
  function centreArmy(id) {
    const a = armyOf(id);
    if (!a) return;
    if (game.selection.army !== id) selectArmy(id);
    const p = centerOf(a);
    if (p) view()?.focus(p);
  }
  function stepArmy(dir) {
    const armies = game.me?.armies || [];
    if (!armies.length) return;
    const i = armies.findIndex((a) => a.id === game.selection.army);
    const next = armies[i < 0 ? (dir > 0 ? 0 : armies.length - 1) : (i + dir + armies.length) % armies.length];
    if (draw) cancelDraw();
    game.setSelection({ army: next.id, divisions: [] });
    probeOrders(next);
    const p = centerOf(next);
    if (p) view()?.focus(p);
  }
  const centerOf = (a) => {
    const ps = a.divs.map((id) => game.divs.get(id)?.prov).filter(Boolean);
    if (!ps.length) return 0;
    const P = game.map.provinces;
    const cx = ps.reduce((s, p) => s + P[p].x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + P[p].y, 0) / ps.length;
    return ps.reduce((b, p) => ((P[p].x - cx) ** 2 + (P[p].y - cy) ** 2 < (P[b].x - cx) ** 2 + (P[b].y - cy) ** 2 ? p : b), ps[0]);
  };

  // Whether the simulation has the orders this screen can only guess the shape of.
  async function probeOrders(a) {
    try {
      const r = await game.query('legal', { order: { type: 'army', name: tr('New Army'), general: null } });
      armyOrder = r.reason !== 'unknown-order' && r.reason !== 'bad-order';
    } catch { armyOrder = false; }
    const off = a?.offensives?.[0];
    if (off) {
      removeProbed = true;
      try { removeOrder = !!(await game.query('legal', { order: { type: 'offensive', army: a.id, offensive: off.id, path: null } })).ok; } catch { removeOrder = false; }
    }
    renderCommands();
  }

  // A new army takes a general of the nation's no other army has, when there is one; onCreated(id) runs once it exists.
  function askArmyName(onCreated) {
    const input = document.createElement('input');
    input.className = 'cq-input';
    const generals = document.createElement('select');
    generals.className = 'cq-select';
    const busy = new Set((game.me?.armies || []).map((a) => a.general).filter(Boolean));
    const none = el('option', null, tr('No general'));
    none.value = '';
    generals.append(none);
    for (const g of game.scenario.nations[game.player]?.generals || []) {
      if (busy.has(g.name)) continue;
      const o = el('option', null, `${g.name} · ${ui.text.trait(g.trait)}`);
      o.value = g.name;
      generals.append(o);
    }
    const body = el('div', 'cq-save-dialog');
    body.append(el('div', null, tr('Army name:')), input, el('div', null, tr('General:')), generals);
    ide.ui.dialog({
      title: tr('New Army'),
      body,
      width: 360,
      buttons: [{ label: tr('New Army'), primary: true, run: async () => {
        const name = input.value.trim();
        if (!name) return;
        const r = await send({ type: 'army', name, general: generals.value || null }, null);
        if (r.ok && r.id) { if (onCreated) await onCreated(r.id); else game.setSelection({ army: r.id, divisions: [] }); }
      } }, { label: tr('Cancel') }],
    });
    setTimeout(() => input.focus(), 30);
  }
  async function askDisband() {
    const a = armyOf(game.selection.army);
    if (!a) return;
    const ok = await ide.ui.confirm(tr('Disband {army}? Its divisions stay where they are, in no army.', { army: a.name }), { title: tr('Disband Army'), ok: tr('Disband Army') });
    if (ok) { const r = await send({ type: 'army', army: a.id, disband: true }, null); if (r.ok) game.setSelection({ army: null }); }
  }

  // ---------- drawing plans ----------
  const land = (id) => id > 0 && !game.map.provinces[id]?.sea;
  function landPath(from, to) {
    const P = game.map.provinces;
    const prev = new Map([[from, 0]]);
    let frontier = [from];
    for (let depth = 0; depth < MAX_GAP && frontier.length; depth++) {
      const next = [];
      for (const p of frontier) {
        for (const q of P[p].adj) {
          if (prev.has(q) || !land(q)) continue;
          prev.set(q, p);
          if (q === to) {
            const out = [];
            for (let x = to; x !== from; x = prev.get(x)) out.push(x);
            return out.reverse();
          }
          next.push(q);
        }
      }
      frontier = next;
    }
    return [to];
  }
  // A drag that comes back over the province before the last takes the last one off; a click never does.
  function addToChain(id, dragging = false) {
    if (!draw || !land(id)) return;
    const c = draw.chain;
    const last = c[c.length - 1];
    if (id === last) return;
    if (dragging && c.length >= 2 && id === c[c.length - 2]) { c.pop(); return previewDraw(); }
    if (c.includes(id)) return;
    if (last === undefined || game.map.provinces[last].adj.includes(id)) c.push(id);
    else for (const p of landPath(last, id)) if (!c.includes(p)) c.push(p);
    previewDraw();
  }
  // The chain as it would be if the province under the pointer were clicked now.
  function pending() {
    const c = draw.chain;
    const h = draw.hover;
    if (!land(h) || c.includes(h)) return c;
    const last = c[c.length - 1];
    if (last === undefined) return [h];
    return c.concat(game.map.provinces[last].adj.includes(h) ? [h] : landPath(last, h).filter((p) => !c.includes(p)));
  }
  const camp = (c) => c >= 0 && (c === game.player || !!game.nations[c]?.ally);
  const hostile = (c) => c >= 0 && c !== game.player && !!game.nations[c]?.war;
  // The border edges a front on these provinces holds against the enemy, as mapbind.js draws an army's front.
  function frontPairs(provs) {
    const P = game.map.provinces;
    const ctrl = game.prov.ctrl;
    const out = [];
    for (const a of provs) {
      if (P[a].sea || !camp(ctrl[a])) continue;
      for (const b of P[a].adj) if (!P[b].sea && hostile(ctrl[b])) out.push([a, b]);
    }
    return out;
  }
  let drawTimer = 0;
  const schedulePreview = () => { if (!drawTimer) drawTimer = setTimeout(previewDraw, DRAW_MS); };
  function previewDraw() {
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (!draw) { bind()?.setPreview(null); showHint(); return; }
    const c = pending();
    if (draw.kind === 'front') {
      const pairs = frontPairs(c);
      draw.pairs = pairs.length;
      bind()?.setPreview({ pairs, fronts: !pairs.length && c.length >= 2 ? [{ provinces: c, color: PREVIEW, width: 1.3 }] : [], arrows: [] });
    } else {
      const a = armyOf(draw.army);
      const start = a && c.length ? nearestDivProv(a, c[0]) : 0;
      const path = start && start !== c[0] ? [start, ...c] : c;
      bind()?.setPreview({ fronts: [], arrows: path.length >= 2 ? [{ path, color: PREVIEW, dashed: true }] : [] });
      askOdds(c[0]);
    }
    draw.preview = c;
    view()?.setSelected(draw.chain[draw.chain.length - 1] || 0);
    renderCommands();
    showHint();
  }
  function nearestDivProv(a, target) {
    const P = game.map.provinces;
    let best = 0;
    let bd = Infinity;
    for (const id of a.divs) {
      const d = game.divs.get(id);
      if (!d) continue;
      const dist = (P[d.prov].x - P[target].x) ** 2 + (P[d.prov].y - P[target].y) ** 2;
      if (dist < bd) { bd = dist; best = d.prov; }
    }
    return best;
  }
  // The odds of the offensive's first battle, asked again only when its first province changes.
  let odds = null; // { prov, seq, r }
  let oddsSeq = 0;
  async function askOdds(prov) {
    if (!prov || odds?.prov === prov) return;
    const seq = ++oddsSeq;
    odds = { prov, seq, r: null };
    let r = null;
    try { r = await game.query('attackOdds', { army: draw.army, prov }); } catch { r = null; }
    if (!draw || oddsSeq !== seq) return;
    odds.r = r;
    showHint();
  }
  let hint = null;
  function showHint() {
    if (!hint) { hint = el('div', 'cq-plan-hint'); hint.setAttribute('role', 'status'); shell.stage.append(hint); }
    hint.hidden = !draw;
    if (!draw) return;
    const army = armyOf(draw.army)?.name || '';
    const c = draw.preview || draw.chain;
    const lines = [draw.kind === 'front'
      ? tr('Front for {army}: click or drag over the provinces it should hold. Enter sets the front, Backspace removes the last province, Esc cancels.', { army })
      : tr('Offensive for {army}: click the provinces to take, toward the objective. Enter plans it, Backspace removes the last province, Esc cancels.', { army })];
    delete hint.dataset.odds;
    if (draw.kind === 'front') lines.push(tr('{n} provinces, {e} border edges facing the enemy', { n: c.length, e: draw.pairs || 0 }));
    else if (c.length) {
      const r = odds?.prov === c[0] ? odds.r : null;
      const province = game.map.provinces[c[0]]?.name || '';
      lines.push(tr('Offensive: {n} provinces', { n: c.length }));
      if (r && !r.defenders) lines.push(tr('{province} has no defenders now.', { province }));
      else if (r && r.attackers) { lines.push(tr('First battle at {province}: {odds} an hour, if the {n} divisions of the army beside it attacked now', { province, odds: ui.text.percent(r.odds), n: r.attackers })); hint.dataset.odds = String(r.odds); }
      else if (r) lines.push(tr('No division of the army stands beside {province} yet.', { province }));
    }
    hint.dataset.kind = draw.kind;
    hint.replaceChildren(...lines.map((t, i) => el('div', i ? 'cq-plan-hint-line' : 'cq-plan-hint-main', t)));
  }
  function startDraw(kind) {
    const army = game.selection.army;
    if (army === null) return;
    draw = { kind, army, chain: [], hover: 0 };
    odds = null;
    view()?.setPainter({
      down(sx, sy) { addToChain(view().provinceAt(sx, sy)); pointer = { sx, sy }; return true; },
      move(sx, sy) { addToChain(view().provinceAt(sx, sy), true); pointer = { sx, sy }; },
      up() {},
    });
    shell.root.classList.add('cq-drawing');
    previewDraw();
  }
  function cancelDraw() {
    draw = null;
    odds = null;
    clearTimeout(drawTimer);
    drawTimer = 0;
    view()?.setPainter(null);
    shell.root.classList.remove('cq-drawing');
    bind()?.setPreview(null);
    showHint();
    renderCommands();
  }
  async function finishDraw() {
    if (!draw) return;
    const { kind, army, chain } = draw;
    const at = pointer;
    cancelDraw();
    if (!chain.length) return;
    const r = kind === 'front' ? await send({ type: 'front', army, provinces: chain }, at) : await send({ type: 'offensive', army, path: chain }, at);
    if (!r.ok) return;
    if (kind === 'offensive') openWhenListed = r.id ?? true;
    shell.toast(kind === 'front' ? tr('Front set: the general moves the army onto it.') : tr('Offensive planned. Launch it when the army is ready.'), at);
    flash(chain[chain.length - 1], kind === 'front' ? tr('Front set') : tr('Offensive planned'));
  }

  // ---------- marks on the map ----------
  const stagePoint = (prov) => {
    const p = game.map.provinces[prov];
    return p && view() ? view().camera.toScreen(p.x + 0.5, p.y + 0.5) : null;
  };
  // A short confirmation at a province that fades by itself.
  function flash(prov, text) {
    const at = stagePoint(prov);
    if (!at) return;
    const f = el('div', 'cq-flash', text);
    f.dataset.prov = String(prov);
    f.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px) translate(-50%, -130%)`;
    shell.stage.append(f);
    setTimeout(() => f.remove(), FLASH_MS);
  }
  // The route preview's tag at its target: the latest arrival, or why the move is refused.
  let tag = null;
  function showTag(prov, text, ok, hours) {
    if (!tag) { tag = el('div', 'cq-route-tag'); shell.stage.append(tag); }
    tag.textContent = text;
    tag.dataset.prov = String(prov);
    tag.dataset.ok = String(ok);
    if (hours === undefined) delete tag.dataset.hours; else tag.dataset.hours = String(hours);
    tag.hidden = false;
    placeTag();
  }
  function placeTag() {
    if (!tag || tag.hidden) return;
    const at = stagePoint(Number(tag.dataset.prov));
    if (at) tag.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px) translate(-50%, calc(-100% - 14px))`;
  }
  const hideTag = () => { if (tag) tag.hidden = true; };

  // ---------- the map ----------
  const mostArmy = (divs) => {
    const counts = new Map();
    for (const id of divs) { const d = game.divs.get(id); if (d?.army !== null && d?.army !== undefined) counts.set(d.army, (counts.get(d.army) || 0) + 1); }
    let army = game.selection.army;
    let most = 0;
    for (const [a, c] of counts) if (c > most) { most = c; army = a; }
    return army;
  };
  function onSelect(e) {
    if (!game.running) return;
    if (e.marker) ui.battle?.open(e.id);
    const hit = e.sx != null && !e.marker ? bind()?.counterAt(e.sx, e.sy) : null;
    if (hit && hit.side === 'own') {
      const own = hit.all.filter((g) => g.side === 'own').flatMap((g) => g.divs);
      const divs = e.shift ? [...new Set([...game.selection.divisions, ...own])] : own;
      const army = mostArmy(divs);
      view()?.setSelected(hit.prov);
      game.setSelection({ province: hit.prov, army, divisions: divs });
      probeOrders(armyOf(army));
      return;
    }
    game.setSelection({ province: hit ? hit.prov : e.id, divisions: e.shift ? game.selection.divisions : [] });
    if (hit) view()?.setSelected(hit.prov);
  }

  async function onContext(e) {
    if (!game.running || draw) return;
    pointer = { sx: e.sx, sy: e.sy };
    const sel = game.selection.divisions.map(mine).filter(Boolean);
    if (!sel.length || !(e.id > 0)) return;
    const at = { sx: e.sx, sy: e.sy };
    clearRoute();
    const rs = await Promise.all(sel.map((d) => game.order({ type: 'move', div: d.id, to: e.id })));
    const ok = rs.filter((r) => r.ok).length;
    const bad = rs.find((r) => !r.ok);
    if (bad) shell.toast(ui.text.reason(bad.reason), at);
    if (ok) flash(e.id, tr('Moving {n} of {m} divisions here', { n: ok, m: sel.length }));
    clearRoute();
  }

  let routeTimer = 0;
  let routeShown = -1;
  let routeSeq = 0;
  function clearRoute() {
    routeShown = -1;
    routeSeq++;
    clearTimeout(routeTimer);
    hideTag();
    showRoutes();
    bind()?.setTooltipExtra('');
  }
  function onHover(e) {
    pointer = e.sx == null ? pointer : { sx: e.sx, sy: e.sy };
    if (!game.running) return;
    if (draw) { draw.hover = e.id; schedulePreview(); return; }
    const sel = game.selection.divisions.map(mine).filter(Boolean);
    if (!sel.length || !(e.id > 0)) { if (routeShown !== -1) clearRoute(); return; }
    if (e.id === routeShown) return;
    clearRoute();
    routeShown = e.id;
    routeTimer = setTimeout(() => previewRoute(sel, e.id), ROUTE_DEBOUNCE_MS);
  }
  async function previewRoute(sel, to) {
    const seq = ++routeSeq;
    if (routeShown !== to) return;
    if (game.map.provinces[to].sea) {
      const why = ui.text.reason('sea');
      bind()?.setTooltipExtra(why);
      showTag(to, why, false);
      return;
    }
    const from = new Map();
    for (const d of sel) if (!from.has(d.prov) && from.size < ROUTE_FROM) from.set(d.prov, d);
    let rs;
    try { rs = await Promise.all([...from.values()].map(async (d) => ({ d, r: await game.query('route', { div: d.id, to }) }))); } catch { return; }
    if (seq !== routeSeq || routeShown !== to) return;
    const ok = rs.filter((x) => x.r.path);
    if (!ok.length) {
      const why = rs[0].r.why;
      const text = ui.text.reason(why === 'sea' ? 'sea-lane-closed' : why === 'cap' ? 'too-far' : 'no-path');
      bind()?.setTooltipExtra(text);
      showTag(to, text, false);
      showRoutes([{ path: [rs[0].d.prov, to], color: REFUSED, dashed: true, width: 0.5 }]);
      return;
    }
    const hours = Math.max(...ok.map((x) => x.r.hours));
    bind()?.setTooltipExtra(tr('Right-click to send: {h} hours on the way', { h: hours }));
    showTag(to, tr('{h} hours, there {date}', { h: hours, date: ui.text.date(game.date(game.hour + hours), true) }), true, hours);
    showRoutes(ok.filter((x) => x.r.path.length).map((x) => ({ path: [x.d.prov, ...x.r.path], color: LEGAL, dashed: true, width: 0.5 })));
  }
  // Where the selected divisions are going (to their destination), plus a route preview.
  function showRoutes(previewArrows = []) {
    const out = [];
    for (const id of game.selection.divisions) {
      const d = mine(id);
      if (d && d.to > 0 && d.dest > 0) out.push({ path: d.dest === d.to ? [d.prov, d.to] : [d.prov, d.to, d.dest], color: '#ffd84a', width: 0.45 });
    }
    bind()?.setExtraArrows(out.concat(previewArrows));
  }

  // ---------- wiring ----------
  ui.events.on('game', () => {
    if (!card) buildCard();
    if (!bar) buildBar();
    draw = null;
    showHint();
    hideTag();
    renderArmies();
    showCard();
    probeOrders(null);
    for (const off of offs.splice(0)) off();
    const v = view();
    offs.push(v.on('select', onSelect), v.on('context', onContext), v.on('hover', onHover), v.on('frame', placeTag));
  });
  ui.events.on('start', () => {
    if (draw) cancelDraw();
    hideTag();
    for (const off of offs.splice(0)) off();
    if (card) card.box.hidden = true;
  });
  let lastSel = { province: 0, army: null, divisions: [] };
  game.on('select', (s) => {
    if (s.province !== lastSel.province || s.divisions.join() !== lastSel.divisions.join()) showCard();
    if (s.army !== lastSel.army) renderArmies();
    if (s.divisions.join() !== lastSel.divisions.join() && routeShown !== -1) clearRoute();
    lastSel = { ...s, divisions: s.divisions.slice() };
    showRoutes();
  });
  game.on('tick', (d) => {
    if (d.me || d.day || d.battles) renderArmies();
    if (d.divs && game.selection.divisions.length) {
      const alive = game.selection.divisions.filter((id) => game.divs.has(id));
      if (alive.length !== game.selection.divisions.length) game.setSelection({ divisions: alive });
      else showRoutes();
    }
    if (d.day && card?.id) showCard();
  });
  game.on('ordered', () => { renderArmies(); if (card?.id) showCard(); });

  const typing = () => { const a = document.activeElement; return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))); };
  const dialogOpen = () => !!document.querySelector('.dialog-backdrop, .modal-backdrop');
  ide.registerAction({ id: 'Conquest.ConfirmPlan', title: tr('Confirm the Plan'), keys: ['Enter'], when: () => !!draw && !typing(), run: () => finishDraw() });
  ide.registerAction({ id: 'Conquest.CancelPlan', title: tr('Cancel the Plan'), keys: ['Escape'], when: () => !!draw, run: () => cancelDraw() });
  ide.registerAction({ id: 'Conquest.UndoPlanStep', title: tr('Remove the Last Province'), keys: ['Backspace'], when: () => !!draw && !typing(), run: () => { draw.chain.pop(); previewDraw(); } });
  ide.registerAction({ id: 'Conquest.ClearSelection', title: tr('Clear the Selection'), keys: ['Escape'], when: () => !draw && game.running && !typing() && !shell.overlayOpen() && !dialogOpen()
    && !!(game.selection.army !== null || game.selection.divisions.length || game.selection.province),
    run: () => { game.setSelection({ army: null, divisions: [], province: 0 }); view()?.setSelected(0); } });
  // Tab steps the armies only while the focus is on the map or the army bar, so it still moves the focus elsewhere.
  const armyKeys = () => {
    if (!game.running || typing() || dialogOpen() || shell.overlayOpen() || !(game.me?.armies || []).length) return false;
    const a = document.activeElement;
    return !a || a === document.body || !!a.closest?.('.cq-stage, .cq-army-list');
  };
  ide.registerAction({ id: 'Conquest.NextArmy', title: tr('Next Army'), keys: ['Tab'], when: armyKeys, run: () => stepArmy(1) });
  ide.registerAction({ id: 'Conquest.PreviousArmy', title: tr('Previous Army'), keys: ['Shift+Tab'], when: armyKeys, run: () => stepArmy(-1) });

  ui.command = { get drawing() { return draw ? { ...draw, chain: draw.chain.slice() } : null; }, startDraw, finishDraw, cancelDraw, addToChain, revealDivision, renderArmies, fitCard, askArmyName, flash, stepArmy, centreArmy, send };
})();
