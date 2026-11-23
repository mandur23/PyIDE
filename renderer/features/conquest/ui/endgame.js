// The end of the game (plan 3.9): when the outcome arrives the game pauses and a screen over the map says first, in
// plain words, whether the player's side won or lost (verdict) and how the player's nation ended, then what ended it,
// and the `outcome` query's scores (goals, cores, land, industry, manpower, total; 1.00 is where it stood in 1914, so
// the last column says better or worse): the player's row pinned on top, then the great powers that fought, the
// other nations that fought, and the neutrals behind a button. A nation fought when it lost men (casualties), is at
// war with the player now, or is gone. Then the timeline of this game from the log, one line per event. Now that it is over, "Show their plans" draws every nation's last fronts and offensives
// (the `plans` query answers them only now). Keep Watching hides the screen and lets time run on; a Results button
// brings it back. Back to Start saves and leaves.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const shell = ui.shell;
  const dip = ui.dip;

  const TIMELINE = new Set(['war', 'peace', 'capitulated', 'collapsed', 'fired', 'event', 'bloc', 'game-over']);
  const COLS = [['goals', () => tr('Goals')], ['cores', () => tr('Cores')], ['land', () => tr('Land')], ['industry', () => tr('Industry')], ['manpower', () => tr('Manpower')], ['total', () => tr('Total')]];

  let parts = null;
  let plansOn = false;

  function build() {
    const box = el('div', 'cq-end');
    box.hidden = true;
    const card = el('div', 'cq-end-card');
    const title = el('div', 'cq-end-title', tr('The War Is Over'));
    const verdict = el('div', 'cq-end-verdict');
    const mine = el('div', 'cq-end-mine');
    const sub = el('div', 'cq-end-sub');
    const table = el('div', 'cq-end-table');
    const tlTitle = el('div', 'cq-dip-section-title', tr('This War'));
    const timeline = el('div', 'cq-end-timeline');
    const plansRow = el('label', 'cq-end-plans');
    const plans = document.createElement('input');
    plans.type = 'checkbox';
    plans.className = 'cq-end-plans-toggle';
    plans.onchange = () => showPlans(plans.checked);
    plansRow.append(plans, el('span', null, tr('Show their plans')), el('span', 'cq-dip-note', tr('Every nation\'s last fronts and offensives on the map.')));
    const btns = el('div', 'cq-end-btns');
    const watch = el('button', 'cq-btn primary cq-end-watch', tr('Keep Watching'));
    const back = el('button', 'cq-btn cq-end-back', tr('Back to Start'));
    watch.onclick = () => keepWatching();
    back.onclick = async () => { await game.save(game.AUTOSAVE); game.close(); };
    btns.append(watch, back);
    card.append(title, verdict, mine, sub, table, plansRow, tlTitle, timeline, btns);
    box.append(card);
    const reopen = el('button', 'cq-btn cq-end-reopen', tr('Results'));
    reopen.hidden = true;
    reopen.onclick = () => show();
    shell.stage.append(box, reopen);
    parts = { box, verdict, mine, sub, table, timeline, plans, reopen };
  }

  function cell(text, cls = '') {
    return el('span', `cq-end-cell ${cls}`, text);
  }

  const blocOf = (n) => game.nations[n]?.bloc || null;
  const fought = (n) => { const x = game.nations[n]; return !!x && (!x.alive || x.casualties > 0 || !!x.war || n === game.player); };
  // { result: 'won' | 'lost' | 'none', text }.
  function verdict(o) {
    const me = game.player;
    if (o.kind === 'bloc-defeated') {
      const bloc = ui.text.bloc(o.bloc);
      if (blocOf(me) === o.bloc) return { result: 'lost', text: tr('Your side lost the war: the {bloc} are defeated.', { bloc }) };
      const against = fought(me) && game.nations.some((x) => x.index !== me && x.bloc === o.bloc && (x.war || x.casualties > 0));
      if (blocOf(me) || against) return { result: 'won', text: tr('Your side won the war: the {bloc} are defeated.', { bloc }) };
      return { result: 'none', text: tr('The war ended without your side: the {bloc} are defeated.', { bloc }) };
    }
    return { result: 'none', text: o.kind === 'general-peace' ? tr('No side won: the war ended in a general peace.') : tr('No side won: the war ran to its last day.') };
  }
  const standing = (s) => (!s.alive ? tr('Gone') : s.total > 1000 ? tr('Better than 1914') : s.total < 1000 ? tr('Worse than 1914') : tr('As in 1914'));

  async function show() {
    if (!game.running || !game.outcome) return;
    if (!parts || !parts.box.isConnected) build();
    if (game.speed > 0) game.setSpeed(0);
    let o = game.outcome;
    try { o = (await game.query('outcome')) || o; } catch {}
    const p = parts;
    p.box.hidden = false;
    p.reopen.hidden = true;
    p.box.dataset.kind = o.kind;
    p.sub.textContent = tr('{what}, {date}', { what: ui.text.outcome(o), date: dip.date(o.hour) });
    const v = verdict(o);
    p.box.dataset.result = v.result;
    p.verdict.textContent = v.text;
    const myScore = (o.scores || []).find((s) => s.nation === game.player);
    const myName = game.nationName(game.player);
    p.mine.textContent = !myScore ? '' : !myScore.alive ? tr('{nation} did not survive the war.', { nation: myName })
      : myScore.total > 1000 ? tr('{nation} ends at {score} of where it stood in 1914: better than in 1914.', { nation: myName, score: ui.text.score(myScore.total) })
        : myScore.total < 1000 ? tr('{nation} ends at {score} of where it stood in 1914: worse than in 1914.', { nation: myName, score: ui.text.score(myScore.total) })
          : tr('{nation} ends where it stood in 1914.', { nation: myName });

    const major = (n) => !!game.scenario.nations[n]?.major;
    const mySide = blocOf(game.player);
    const ours = (n) => (mySide && blocOf(n) === mySide ? 1 : 0);
    const order = (a, b) => (ours(b.nation) - ours(a.nation)) || (b.alive - a.alive) || b.total - a.total || a.nation - b.nation;
    const others = (o.scores || []).filter((s) => s.nation !== game.player).sort(order);
    const groups = [
      ['majors', tr('Great powers at war'), others.filter((s) => fought(s.nation) && major(s.nation))],
      ['fought', tr('Other nations at war'), others.filter((s) => fought(s.nation) && !major(s.nation))],
      ['neutral', null, others.filter((s) => !fought(s.nation))],
    ];
    const head = el('div', 'cq-end-row head');
    head.append(cell(tr('Nation'), 'name'), ...COLS.map(([, t]) => cell(t(), 'num')), cell(tr('Against 1914'), 'vs'));
    const out = [head];
    if (myScore) out.push(row(myScore));
    for (const [id, label, list] of groups) {
      if (!list.length) continue;
      if (id === 'neutral') {
        const more = el('button', 'cq-end-group cq-end-neutrals');
        const rows = list.map(row);
        const set = (open) => {
          more.setAttribute('aria-expanded', String(open));
          more.textContent = open ? tr('Hide the neutral nations ({n})', { n: list.length }) : tr('Show the neutral nations ({n})', { n: list.length });
          for (const r of rows) r.hidden = !open;
        };
        more.onclick = () => set(more.getAttribute('aria-expanded') !== 'true');
        set(false);
        out.push(more, ...rows);
      } else {
        const h = el('div', 'cq-end-group', label);
        h.dataset.group = id;
        out.push(h, ...list.map(row));
      }
    }
    p.table.replaceChildren(...out);
    p.table.scrollTop = 0;

    function row(s) {
      const r = el('div', `cq-end-row${s.nation === game.player ? ' me' : ''}${s.alive ? '' : ' gone'}`);
      r.dataset.nation = String(s.nation);
      const name = el('span', 'cq-end-cell name');
      name.append(dip.chip(s.nation), dip.nameEl(s.nation));
      if (s.nation === game.player) name.append(el('span', 'cq-end-tag you', tr('Your nation')));
      else if (blocOf(s.nation)) name.append(el('span', 'cq-end-tag', ui.text.bloc(blocOf(s.nation))));
      const vs = standing(s);
      r.append(name, ...COLS.map(([k]) => {
        const c = cell(s[k] === null || s[k] === undefined ? '–' : ui.text.score(s[k]), 'num');
        c.dataset.col = k;
        c.dataset.value = String(s[k]);
        return c;
      }), cell(vs, `vs ${s.total >= 1000 && s.alive ? 'up' : 'down'}`));
      return r;
    }

    const events = ui.text.oncePerEvent(game.log.filter((e) => TIMELINE.has(e.kind)));
    p.timeline.replaceChildren(...(events.length ? events.map((e) => {
      const r = el('div', `cq-log-row cq-log-${e.kind}`);
      r.append(el('span', 'cq-log-date', dip.date(e.hour)), el('span', 'cq-log-text', ui.text.log(e)));
      return r;
    }) : [el('div', 'cq-dip-empty', tr('Nothing happened.'))]));
    p.plans.checked = plansOn;
  }

  function keepWatching() {
    parts.box.hidden = true;
    parts.reopen.hidden = false;
    game.setSpeed(game.speed > 0 ? game.speed : 3);
  }

  async function showPlans(on) {
    plansOn = on;
    const bind = shell.bind;
    if (!bind) return;
    if (!on) { bind.setPreview(null); return; }
    const fronts = [];
    const arrows = [];
    for (const x of game.nations) {
      if (!x.alive) continue;
      let plans = [];
      try { plans = await game.query('plans', { nation: x.index }); } catch { continue; }
      const color = game.scenario.nations[x.index]?.color || '#888888';
      for (const a of plans) {
        if (a.front && a.front.length >= 2) fronts.push({ provinces: a.front, color, width: 1 });
        for (const o of a.offensives || []) if (o.path && o.path.length >= 2) arrows.push({ path: o.path, color, dashed: !o.on, width: 0.8 });
      }
    }
    if (plansOn) bind.setPreview({ fronts, arrows });
  }

  game.on('over', () => show());
  game.on('loaded', () => {
    plansOn = false;
    if (parts) { parts.box.hidden = true; parts.reopen.hidden = true; }
    if (game.outcome) setTimeout(show, 0);
  });
  game.on('closed', () => {
    plansOn = false;
    if (parts) { parts.box.hidden = true; parts.reopen.hidden = true; }
  });
  ui.endgame = { show, verdict, get shown() { return !!parts && !parts.box.hidden; } };
})();
