// The judgment panel, "why did the AI decide that" (plan 5.5): for a nation picked here (by default the one picked in
// the diplomacy panel, else our main enemy) its recent decisions newest first from the `explain` query, each with its
// layer and date, the choice in words, the top options with score bars and the chosen one marked, and the factors
// that moved the score with signed deltas; then its historical goals with their weight now and the last change with
// its main reason; then what it remembers. Names of provinces in a decision focus the map. The worker answers
// another nation's operations decisions (where it will attack) only after the game is over, so the panel says so.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;
  const dip = ui.dip;

  const MEMORY_SHOWN = 12;
  const ALIAS = { 'answer-accept': 'accept', 'answer-refuse': 'refuse', 'offer-peace': 'peace-terms', 'main-enemy': 'target', 'goal-weight': 'goal-weight', 'join-bloc': 'join-bloc' };

  // The option a decision took: the one with the chosen label (or its alias) whose args agree with the chosen args.
  function chosenIndex(d) {
    const c = d.chosen || {};
    const label = ALIAS[c.label] || c.label;
    let best = -1;
    let bestScore = -1;
    d.options.forEach((o, i) => {
      if (o.label !== label) return;
      const keys = Object.keys(o.args || {});
      const agree = keys.filter((k) => c.args && c.args[k] === o.args[k]).length;
      const s = keys.length ? agree / keys.length : 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best < 0 && c.label === 'offer-peace' && d.options.length) best = d.options.length - 1;
    if (c.label === 'keep-peace') best = d.options.findIndex((o) => o.label === 'keep-peace');
    if (c.label === 'stay-out') best = d.options.findIndex((o) => o.label === 'stay-out');
    return best;
  }

  ui.panel({
    id: 'judgment', title: tr('Judgment'), icon: 'evaluate', order: 310,
    mount(root) {
      const wrap = el('div', 'cq-jdg');
      const head = el('div', 'cq-jdg-head');
      const pick = document.createElement('select');
      pick.className = 'cq-select cq-jdg-nation';
      head.append(el('span', 'cq-dip-sub', tr('Nation')), pick);
      const hidden = el('div', 'cq-dip-note cq-jdg-hidden', tr('Its operations plans (where it will attack) stay hidden until the war is over.'));
      const decTitle = el('div', 'cq-dip-section-title', tr('Recent Decisions'));
      const decs = el('div', 'cq-jdg-decisions');
      const goalTitle = el('div', 'cq-dip-section-title', tr('Historical Goals'));
      const goals = el('div', 'cq-jdg-goals');
      const memTitle = el('div', 'cq-dip-section-title', tr('What It Remembers'));
      const feel = el('div', 'cq-jdg-feel');
      const mem = el('div', 'cq-jdg-memory');
      wrap.append(head, hidden, decTitle, decs, goalTitle, goals, memTitle, feel, mem);
      root.append(wrap);

      let current = null;
      let follow = true;
      pick.onchange = () => { current = Number(pick.value); follow = false; render(); };

      function fillPicker() {
        const sc = game.scenario.nations;
        const list = game.nations.filter((x) => x.alive || x.index === current).slice()
          .sort((a, b) => (sc[b.index]?.major ? 1 : 0) - (sc[a.index]?.major ? 1 : 0) || game.nationName(a.index).localeCompare(game.nationName(b.index)));
        pick.replaceChildren(...list.map((x) => {
          const o = document.createElement('option');
          o.value = String(x.index);
          o.textContent = x.index === game.player ? tr('{nation} (us)', { nation: game.nationName(x.index) }) : game.nationName(x.index);
          return o;
        }));
        pick.value = String(current);
      }

      const factorRow = (f, n) => {
        const r = el('div', `cq-dip-factor ${f.delta >= 0 ? 'pos' : 'neg'}`);
        r.dataset.label = f.label;
        r.dataset.delta = String(f.delta);
        r.append(dip.partsEl(ui.text.factor(f.label, f.args, n, true), 'cq-dip-factor-text'), el('span', 'cq-dip-factor-delta', ui.text.signed(f.delta)));
        return r;
      };

      function card(d, n) {
        const c = el('div', `cq-jdg-card cq-jdg-${d.layer}`);
        c.dataset.layer = d.layer;
        c.dataset.label = d.chosen?.label || '';
        const top = el('div', 'cq-jdg-card-top');
        top.append(el('span', `cq-jdg-layer ${d.layer}`, ui.text.layer(d.layer)), el('span', 'cq-jdg-date', dip.date(d.hour)));
        c.append(top, dip.partsEl(ui.text.decision(d.chosen?.label, d.chosen?.args, n, true), 'cq-jdg-chosen'));
        if (d.options.length) {
          const pickI = chosenIndex(d);
          const max = Math.max(1, ...d.options.map((o) => Math.abs(o.score)));
          const opts = el('div', 'cq-jdg-options');
          d.options.forEach((o, i) => {
            const r = el('div', `cq-jdg-option${i === pickI ? ' chosen' : ''}`);
            r.dataset.label = o.label;
            r.dataset.score = String(o.score);
            const bar = el('span', 'cq-jdg-bar');
            const fill = el('span', 'cq-jdg-bar-fill');
            fill.style.width = `${Math.max(0, (o.score / max) * 100)}%`;
            bar.append(fill);
            r.append(el('span', 'cq-jdg-mark', i === pickI ? '✓' : ''), dip.partsEl(ui.text.decision(o.label, o.args, n, true), 'cq-jdg-option-text'), bar, el('span', 'cq-jdg-score', ui.text.score(o.score)));
            if (i === pickI) r.title = tr('Chosen');
            opts.append(r);
          });
          c.append(opts);
        }
        if (d.factors.length) {
          const fs = el('div', 'cq-dip-factors');
          fs.append(el('div', 'cq-dip-note', tr('What moved the score')), ...d.factors.map((f) => factorRow(f, n)));
          c.append(fs);
        }
        return c;
      }

      let seq = 0;
      async function render() {
        if (!game.running) return;
        if (follow) {
          const want = dip.selected ?? dip.mainEnemy() ?? game.player;
          current = want;
        }
        if (current === null || !game.nations[current]) current = game.player;
        fillPicker();
        const n = current;
        const my = ++seq;
        wrap.dataset.nation = String(n);
        const [decisions, info, memory] = await Promise.all([
          game.query('explain', { nation: n }).catch(() => []),
          game.query('nation', { nation: n }).catch(() => null),
          game.query('memory', { nation: n, summary: true }).catch(() => null),
        ]);
        if (my !== seq) return;
        hidden.hidden = n === game.player || !!game.outcome;
        decs.replaceChildren(...(decisions.length ? decisions.map((d) => card(d, n)) : [el('div', 'cq-dip-empty', n === game.player ? tr('Our own decisions are the orders we give; the general carries out our plans.') : tr('No decisions yet.'))]));

        const changes = new Map();
        for (const d of decisions) if (d.chosen?.label === 'goal-weight' && d.chosen.args && !changes.has(d.chosen.args.goal)) changes.set(d.chosen.args.goal, d);
        const gl = info?.goals || [];
        goals.replaceChildren(...(gl.length ? gl.map((g) => {
          const r = el('div', 'cq-jdg-goal');
          r.dataset.goal = g.id;
          r.append(el('span', 'cq-dip-goal-name', ui.text.goal(g, n)), el('span', 'cq-dip-goal-w', ui.text.score(g.weight)));
          const ch = changes.get(g.id);
          if (ch) {
            const why = ch.factors.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
            const line = el('div', 'cq-jdg-goal-change');
            line.append(document.createTextNode(tr('{from} to {to}, mainly: ', { from: ui.text.score(ch.chosen.args.from), to: ui.text.score(ch.chosen.args.to) })));
            line.append(why ? dip.partsEl(ui.text.factor(why.label, why.args, n, true)) : document.createTextNode(tr('Its usual stance')));
            r.append(line);
          } else if (!g.base) r.append(el('div', 'cq-jdg-goal-change', tr('Grown from what it remembers of this war')));
          else if (g.base !== g.weight) r.append(el('div', 'cq-jdg-goal-change', tr('{from} at the start', { from: ui.text.score(g.base) })));
          return r;
        }) : [el('div', 'cq-dip-empty', tr('No historical goals.'))]));

        const about = memory?.about || [];
        feel.replaceChildren(...about.slice().sort((a, b) => (b.grudge - b.trust) - (a.grudge - a.trust)).slice(0, 6).map((row) => {
          const r = el('div', 'cq-jdg-feel-row');
          r.dataset.about = String(row.nation);
          r.append(dip.chip(row.nation), dip.nameEl(row.nation), el('span', 'cq-dip-ledger-eff', tr('trust {t}, grudge {g}', { t: ui.text.signed(row.trust), g: ui.text.score(row.grudge) })));
          return r;
        }));
        const lines = [];
        for (const row of about) for (const l of row.lines) lines.push({ ...l, about: row.nation });
        lines.sort((a, b) => b.hour - a.hour);
        mem.replaceChildren(...(lines.length ? lines.slice(0, MEMORY_SHOWN).map((l) => {
          const r = el('div', 'cq-dip-ledger-row compact');
          r.dataset.kind = l.kind;
          r.append(el('span', 'cq-dip-ledger-date', dip.date(l.hour)), dip.partsEl(ui.text.memory(l.kind, l.about, true), 'cq-dip-ledger-text'));
          return r;
        }) : [el('div', 'cq-dip-empty', tr('Nothing yet.'))]));
      }

      const offSel = ui.events.on('dip-select', () => { follow = true; if (!root.hidden) render(); });
      return { update: render, destroy: offSel };
    },
  });
})();
