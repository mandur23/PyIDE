// The battle window and the division detail (Conquest.ui.battle, Conquest.ui.divDetail).
// battle.open(prov) shows the battle in prov, one at a time: a labelled, non-modal dialog in the map's stage, placed
// beside the province so it does not cover it. It asks the `battle` query (sim/queries.js) again whenever the mirror's
// battle there has fought another hour, so it follows the battle live; when the battle's log entry arrives it says how
// the battle ended and stays until closed (its button, or Escape through shell.overlays). It shows who attacks whom,
// the hours, the hourly odds as one balance bar, both sides' divisions in two columns with their organisation and
// strength bars and their role that hour, the width in use and the directions of attack, each side's factors as the
// sim computed them (signed, largest first), and the rules a player cannot guess (pursuit when not dug in, the places
// in the defending line). divDetail.show(id, host) draws one division into host (the province card's or the battle
// window's detail box): its template's composition and stats, organisation, strength, supply, entrenchment, its army
// and general, where it goes and when it arrives (the player's own only), and who directs it.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;
  const pc = (x) => ui.text.percent(x);
  const signedPc = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x / 10))}%`;
  const REFRESH_MS = 400;

  // A bar with its value as text beside it (the text is what a screen reader and a test read).
  function meter(cls, label, permille) {
    const box = el('div', `cq-meter ${cls}`);
    const track = el('div', 'cq-meter-track');
    const fill = el('div', 'cq-meter-fill');
    fill.style.width = `${Math.max(0, Math.min(100, permille / 10))}%`;
    track.append(fill);
    track.setAttribute('aria-hidden', 'true');
    box.append(el('span', 'cq-meter-label', label), track, el('span', 'cq-meter-value', pc(permille)));
    box.dataset.v = String(permille);
    return box;
  }
  const sideName = (list, fallback) => {
    const ns = [...new Set(list.map((d) => d.nation))];
    if (!ns.length) return game.nationName(fallback);
    const main = ns.includes(fallback) ? fallback : ns[0];
    return ns.length > 1 ? tr('{nation} and {n} more', { nation: game.nationName(main), n: ns.length - 1 }) : game.nationName(main);
  };

  // ---------- the battle window ----------
  let win = null;
  function build() {
    const box = el('div', 'cq-battle');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-labelledby', 'cq-battle-title');
    box.hidden = true;
    const head = el('div', 'cq-battle-head');
    const title = el('div', 'cq-battle-title');
    title.id = 'cq-battle-title';
    const close = el('button', 'cq-icon-btn cq-battle-close');
    close.append(ide.icon('closeSmall'));
    close.title = ide.keymap.withKeys(tr('Close the Battle Window'), 'Conquest.Escape');
    close.setAttribute('aria-label', tr('Close the Battle Window'));
    close.onclick = () => closeBattle();
    head.append(title, close);
    const body = el('div', 'cq-battle-body');
    const detail = el('div', 'cq-div-detail-host');
    detail.hidden = true;
    box.append(head, body, detail);
    shell.stage.append(box);
    win = { box, title, body, detail, prov: 0, data: null, ended: null, busy: false, again: false, hours: -1, placed: false };
  }

  function open(prov) {
    if (!game.running || !(prov > 0)) return;
    if (!win) build();
    if (win.prov !== prov) { win.data = null; win.ended = null; win.hours = -1; win.placed = false; divDetail.close(win.detail); }
    win.prov = prov;
    win.box.hidden = false;
    win.box.dataset.province = String(prov);
    refresh();
  }
  function closeBattle() {
    if (!win || win.box.hidden) return;
    divDetail.close(win.detail);
    win.box.hidden = true;
    win.prov = 0;
    win.data = null;
  }
  const isOpen = () => !!(win && !win.box.hidden);

  async function refresh() {
    if (!isOpen()) return;
    if (win.busy) { win.again = true; return; }
    win.busy = true;
    const prov = win.prov;
    try {
      const r = await game.query('battle', { prov });
      if (win.prov === prov && !win.ended) { win.data = r; win.hours = r.hours; }
    } catch (err) {
      if (win.prov === prov && err.message === 'no-battle' && !win.ended) win.ended = lastEnd(prov) || { won: null, hours: win.data?.hours ?? 0 };
    }
    win.busy = false;
    if (win.prov === prov) render();
    if (win.again) { win.again = false; refresh(); }
  }
  const lastEnd = (prov) => { for (let i = game.log.length - 1; i >= 0; i--) { const e = game.log[i]; if (e.kind === 'battle' && e.prov === prov) return e; } return null; };

  function render() {
    if (!isOpen()) return;
    const d = win.data;
    const P = game.map.provinces[win.prov];
    win.title.textContent = tr('Battle for {province}', { province: P?.name || '' });
    win.box.classList.toggle('ended', !!win.ended);
    win.box.dataset.ended = win.ended ? String(win.ended.won || '') : '';
    if (!d) { win.body.replaceChildren(el('div', 'cq-battle-note', win.ended ? endText(win.ended, null) : tr('Loading…'))); return; }
    const attName = sideName(d.att, d.side);
    const defName = sideName(d.def, d.defender);
    const out = [];
    if (win.ended) out.push(el('div', 'cq-battle-end', endText(win.ended, d)));
    out.push(el('div', 'cq-battle-sub', tr('{att} attacks {def} · {h} hours fought', { att: attName, def: defName, h: win.ended?.hours ?? d.hours })));
    // The balance: the attackers' hourly chance against the defenders'.
    const bal = el('div', 'cq-balance');
    bal.dataset.odds = String(d.odds);
    const track = el('div', 'cq-balance-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('div', 'cq-balance-att');
    fill.style.width = `${d.odds / 10}%`;
    track.append(fill);
    const labels = el('div', 'cq-balance-labels');
    labels.append(el('span', 'cq-balance-a', `${attName} ${pc(d.odds)}`), el('span', 'cq-balance-d', `${pc(1000 - d.odds)} ${defName}`));
    bal.append(labels, track, el('div', 'cq-balance-cap', tr('The chance each hour that the attackers win the hour: {odds}', { odds: pc(d.odds) })));
    out.push(bal);
    // The divisions.
    const cols = el('div', 'cq-battle-cols');
    const col = (side, title, list) => {
      const c = el('div', `cq-battle-col cq-battle-${side}`);
      c.dataset.side = side;
      const engaged = list.filter((x) => x.role === 'engaged').length;
      c.append(el('div', 'cq-battle-col-head', tr('{side}: {n} divisions, {e} engaged', { side: title, n: list.length, e: engaged })));
      const order = { engaged: 0, waiting: 1, outside: 2, broken: 3 };
      for (const x of list.slice().sort((a, b) => order[a.role] - order[b.role] || b.org - a.org || a.id - b.id)) c.append(divRow(x));
      return c;
    };
    cols.append(col('att', attName, d.att), col('def', defName, d.def));
    out.push(cols);
    // Width and directions.
    const h = d.hour;
    if (h) {
      const used = Math.max(h.att.length, h.def.length);
      const from = h.dirs.map((p) => game.map.provinces[p]?.name).filter(Boolean).join(', ');
      const w = el('div', 'cq-battle-width', h.dirs.length === 1
        ? tr('Combat width {used} of {max}: attacked from one direction ({from}); each direction after the first widens it by one.', { used, max: h.width, from })
        : tr('Combat width {used} of {max}: attacked from {n} directions ({from}); each direction after the first widens it by one.', { used, max: h.width, n: h.dirs.length, from }));
      w.dataset.width = String(h.width);
      w.dataset.used = `${h.att.length},${h.def.length}`;
      out.push(w);
      const facts = el('div', 'cq-battle-factors');
      const list = (side, title, rows) => {
        const f = el('div', `cq-factor-list cq-factor-${side}`);
        f.dataset.side = side;
        f.append(el('div', 'cq-factor-head', title));
        if (!rows.length) f.append(el('div', 'cq-factor-none', tr('Nothing changes this side\'s power.')));
        for (const r of rows) {
          const row = el('div', `cq-factor ${r.effect > 0 ? 'good' : 'bad'}`);
          row.dataset.k = r.key;
          row.dataset.v = String(r.effect);
          row.append(el('span', 'cq-factor-label', ui.text.combat(r.key)), el('span', 'cq-factor-value', signedPc(r.effect)));
          f.append(row);
        }
        return f;
      };
      facts.append(list('att', tr('Why the attackers have this power'), d.factors.att), list('def', tr('Why the defenders have this power'), d.factors.def));
      out.push(facts);
    } else out.push(el('div', 'cq-battle-note', tr('The reasons appear after the next hour of battle.')));
    // The rules behind it.
    const notes = el('div', 'cq-battle-rules');
    notes.append(el('div', 'cq-battle-rule cq-rule-dug', d.dug
      ? tr('Dug in (trenches {works} of {need}): attackers who win walk in at their own pace.', { works: d.works, need: d.trench })
      : tr('Not dug in (trenches {works} of {need}): if the attackers win, they take the province within the hour.', { works: d.works, need: d.trench })));
    const lineEl = el('div', 'cq-battle-rule cq-rule-line', tr('{n} of the {max} places in the defending line have been used; when the line can no longer fight, the defenders outside it fall back.', { n: d.line.length, max: d.lineMax }));
    lineEl.dataset.used = String(d.line.length);
    notes.append(lineEl);
    out.push(notes);
    win.body.replaceChildren(...out);
    if (!win.placed) place();
  }
  function endText(e, d) {
    const h = e.hours ?? d?.hours ?? 0;
    if (e.won === 'att') return tr('The battle is over: the attackers won after {h} hours.', { h });
    if (e.won === 'def') return tr('The battle is over: the defenders held after {h} hours.', { h });
    return tr('The battle is over.');
  }
  function divRow(x) {
    const r = el('button', `cq-bdiv cq-role-${x.role}`);
    r.dataset.div = String(x.id);
    r.dataset.role = x.role;
    const name = el('span', 'cq-bdiv-name', x.armyName ? `${x.tplName} · ${x.armyName}` : x.tplName);
    name.dataset.userText = '';
    const top = el('div', 'cq-bdiv-top');
    top.append(name, el('span', 'cq-bdiv-role', ui.text.role(x.role)));
    r.append(top, el('div', 'cq-bdiv-nation', game.nationName(x.nation)), meter('org', tr('org'), x.org), meter('str', tr('str'), x.str));
    r.onclick = () => divDetail.show(x.id, win.detail);
    return r;
  }
  // Beside the province: on the side of it with more room, so the province stays in view.
  function place() {
    const v = shell.view;
    const P = game.map.provinces[win.prov];
    if (!v || !P) return;
    const [px, py] = v.camera.toScreen(P.x + 0.5, P.y + 0.5);
    const W = shell.stage.clientWidth;
    const H = shell.stage.clientHeight;
    const w = win.box.offsetWidth;
    const h = win.box.offsetHeight;
    const GAP = 48;
    const right = px + GAP;
    const left = px - GAP - w;
    let x = W - right >= left ? right : left;
    x = Math.max(8, Math.min(W - w - 8, x));
    const y = Math.max(8, Math.min(H - h - 8, py - h / 2));
    win.box.style.left = `${x}px`;
    win.box.style.top = `${y}px`;
    win.placed = true;
  }

  // ---------- the division detail ----------
  const STATS = [['attack', () => tr('Attack'), 1], ['breakthrough', () => tr('Breakthrough'), 1], ['defence', () => tr('Defence'), 1], ['org', () => tr('Organisation'), 1000],
    ['speed', () => tr('Speed'), 1000], ['supply', () => tr('Supply use'), 1], ['siege', () => tr('Siege'), 1], ['river', () => tr('River crossing'), 1], ['shells', () => tr('Shells an hour'), 1], ['manpower', () => tr('Manpower'), 1]];
  const detail = { id: 0, host: null, seq: 0, at: 0 };
  const divDetail = {
    get id() { return detail.host && !detail.host.hidden ? detail.id : 0; },
    show(id, host) { if (detail.host && detail.host !== host) divDetail.close(detail.host); detail.id = id; detail.host = host; host.hidden = false; draw(); },
    close(host = detail.host) { if (!host || host !== detail.host) return; host.hidden = true; host.replaceChildren(); detail.id = 0; detail.host = null; },
    refresh() { if (divDetail.id && performance.now() - detail.at > REFRESH_MS) draw(); },
  };
  async function draw() {
    const { id, host } = detail;
    const seq = ++detail.seq;
    detail.at = performance.now();
    let d;
    try { d = await game.query('division', { id }); } catch { if (seq === detail.seq) { host.replaceChildren(el('div', 'cq-battle-note', tr('This division no longer exists.'))); } return; }
    const own = d.nation === game.player;
    let route = null;
    if (own && d.dest > 0 && d.dest !== d.prov) { try { route = await game.query('route', { div: id, to: d.dest }); } catch {} }
    if (seq !== detail.seq || detail.host !== host) return;
    const P = game.map.provinces;
    const box = el('div', 'cq-div-detail');
    box.dataset.div = String(id);
    const head = el('div', 'cq-div-detail-head');
    const name = el('div', 'cq-div-detail-name', d.tplName);
    name.dataset.userText = '';
    const close = el('button', 'cq-icon-btn cq-div-detail-close');
    close.append(ide.icon('closeSmall'));
    close.title = ide.keymap.withKeys(tr('Close the Division'), 'Conquest.Escape');
    close.setAttribute('aria-label', tr('Close the Division'));
    close.onclick = () => divDetail.close(host);
    head.append(name, close);
    const line = (cls, text) => { const n = el('div', `cq-div-detail-line ${cls}`, text); return n; };
    const general = d.general ? (d.trait ? `${d.general} · ${ui.text.trait(d.trait)}` : d.general) : null;
    const ready = game.nations[d.nation]?.ready ?? 1000;
    const parts = [head, line('cq-dd-nation', game.nationName(d.nation)),
      line('cq-dd-army', !d.armyName ? tr('In no army') : general ? tr('{army}, general {general}', { army: d.armyName, general }) : tr('{army}, no general', { army: d.armyName })),
      line('cq-dd-who', d.manual ? tr('Directed by you (direct control): the general leaves it be.') : d.army !== null ? tr('Directed by its general.') : tr('Not in an army: it waits for orders.'))];
    if (d.to > 0) {
      const next = P[d.to]?.name || '';
      parts.push(line('cq-dd-move', own && route?.path && d.dest !== d.to
        ? tr('Going to {dest}: next {next} in {eta} hours, there in {h} hours.', { dest: P[d.dest]?.name || '', next, eta: d.eta, h: route.hours })
        : tr('Entering {next} in {eta} hours.', { next, eta: d.eta })));
    } else parts.push(line('cq-dd-move', tr('Standing in {prov}.', { prov: P[d.prov]?.name || '' })));
    const bars = el('div', 'cq-dd-bars');
    bars.append(meter('org', tr('Organisation'), d.org), meter('str', tr('Strength'), d.str), meter('sup', tr('Supply'), d.sup));
    parts.push(bars, line('cq-dd-dig', tr('Entrenchment {dig} · readiness of its nation {ready}', { dig: d.dig, ready: pc(ready) })));
    if (d.template) {
      const count = (list) => { const m = new Map(); for (const b of list) m.set(b, (m.get(b) || 0) + 1); return [...m].map(([b, n]) => `${n} × ${ui.text.branch(b)}`).join(', '); };
      const comp = el('div', 'cq-dd-comp');
      comp.dataset.line = d.template.line.join(',');
      comp.dataset.support = d.template.support.join(',');
      comp.append(line('cq-dd-line', tr('Line: {list}', { list: count(d.template.line) })), line('cq-dd-support', tr('Support: {list}', { list: d.template.support.length ? count(d.template.support) : tr('None') })));
      parts.push(comp);
    }
    if (d.stats) {
      const grid = el('div', 'cq-dd-stats');
      for (const [k, label, scale] of STATS) {
        const v = d.stats[k] ?? 0;
        const r = el('div', 'cq-dd-stat');
        r.dataset.k = k;
        r.dataset.v = String(v);
        r.append(el('span', 'cq-dd-stat-label', label()), el('span', 'cq-dd-stat-value', scale === 1 ? String(v) : (v / scale).toFixed(1)));
        grid.append(r);
      }
      parts.push(grid);
    }
    box.append(...parts);
    const first = !host.firstChild;
    host.replaceChildren(box);
    // Scroll only the window or card that holds it: scrollIntoView also scrolls the map's stage, which hides overflow.
    const holder = host.closest('.cq-battle, .cq-card');
    if (first && holder && host.offsetTop + host.offsetHeight > holder.scrollTop + holder.clientHeight) holder.scrollTop = Math.max(0, host.offsetTop - 8);
  }

  // ---------- wiring ----------
  game.on('tick', (t) => {
    if (isOpen() && !win.ended) {
      const b = game.battles.find((x) => x.prov === win.prov);
      if (!b || b.hours !== win.hours) refresh();
    }
    if (t.divs) divDetail.refresh();
  });
  game.on('event', (e) => {
    if (isOpen() && !win.ended && e?.kind === 'battle' && e.prov === win.prov) { win.ended = e; render(); }
  });
  ui.events.on('start', () => { closeBattle(); divDetail.close(); });
  ui.events.on('game', () => { closeBattle(); divDetail.close(); });
  shell.overlays.push({ open: () => !!divDetail.id, close: () => divDetail.close() }, { open: isOpen, close: closeBattle });

  ui.battle = { open, close: closeBattle, get prov() { return isOpen() ? win.prov : 0; }, get data() { return win?.data || null; }, get ended() { return win?.ended || null; } };
  ui.divDetail = divDetail;
})();
