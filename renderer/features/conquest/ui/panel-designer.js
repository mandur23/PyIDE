// The Division Designer panel (plan 3.3): the nation's templates with how many divisions use each; for the one being
// edited a name, a grid of rules.template.maxLine combat slots and maxSupport support slots, each with the branch's
// symbol (ui/eco-common.js) and a picker of the branches the nation may use there (locked ones shown as locked;
// support-only branches only in support slots); the stats from the worker's `stats` query with signed deltas against
// the saved template; what one division costs; the counters check, plain lines worked out from the rules (enemy
// machine guns against infantry and cavalry, trench-breaking siege, horses and supply in mud, shells against stock and
// production, speed), each with its number; Save as New and Apply, both `template` orders (a refusal shows its
// translated reason), and the training form (ui/eco-train.js). Applying a changed template changes the divisions of
// it already in the field at once (their stats are derived from the template), which the panel says before Apply.
// Panel id 'designer'.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;

  const STATS = [
    ['attack', () => tr('Attack'), 1],
    ['breakthrough', () => tr('Breakthrough'), 1],
    ['defence', () => tr('Defence'), 1],
    ['org', () => tr('Organisation'), 1000],
    ['speed', () => tr('Speed'), 1000],
    ['supply', () => tr('Supply use'), 1],
    ['siege', () => tr('Siege'), 1],
    ['shells', () => tr('Shells an hour'), 1],
    ['manpower', () => tr('Manpower'), 1],
  ];
  // Stats where less is better: their deltas read green when negative.
  const LOWER_BETTER = new Set(['supply', 'shells', 'manpower']);

  const compact = (draft) => ({ id: draft.id, name: draft.name.trim() || draft.id, line: draft.line.filter(Boolean), support: draft.support.filter(Boolean) });
  const sameTpl = (a, b) => !!a && !!b && a.name === b.name && a.line.join() === b.line.join() && a.support.join() === b.support.join();

  function mount(root) {
    root.classList.add('cq-designer');
    const E = ui.eco;
    const R = game.rules;
    const T = R.template;
    let selected = null;
    let draft = null;
    let seq = 0;

    // ---------- templates ----------
    const listBody = E.section(root, tr('Division Templates'), 'cq-sec-templates');
    const list = el('div', 'cq-tpl-list');
    listBody.append(list);

    // ---------- the edited template ----------
    const editBody = E.section(root, tr('Layout'), 'cq-sec-layout');
    const name = document.createElement('input');
    name.className = 'cq-input cq-tpl-name';
    name.maxLength = 40;
    name.oninput = () => { draft.name = name.value; refresh(); };
    const lineGrid = el('div', 'cq-slots cq-slots-line');
    const supportGrid = el('div', 'cq-slots cq-slots-support');
    const addBtn = el('button', 'cq-btn cq-add-slot', tr('Add Battalion'));
    addBtn.title = tr('Fill the next empty combat slot with infantry');
    const slotMsg = el('div', 'cq-eco-msg cq-slot-msg');
    addBtn.onclick = () => {
      const i = draft.line.indexOf(null);
      if (i < 0) { slotMsg.textContent = ui.text.reason('too-large'); slotMsg.classList.add('bad'); return; }
      setSlot('line', i, 'inf');
    };
    editBody.append(el('label', 'cq-eco-sub', tr('Template Name')), name, el('div', 'cq-eco-sub', tr('Combat battalions')), lineGrid,
      el('div', 'cq-eco-sub', tr('Support companies')), supportGrid, addBtn, slotMsg);
    const slotNodes = { line: [], support: [] };
    const makeSlot = (kind, i) => {
      const b = el('button', `cq-slot cq-slot-${kind}`);
      b.dataset.kind = kind;
      b.dataset.slot = String(i);
      b.onclick = (e) => { e.stopPropagation(); openPicker(b, kind, i); };
      return b;
    };
    for (let i = 0; i < T.maxLine; i++) { const b = makeSlot('line', i); slotNodes.line.push(b); lineGrid.append(b); }
    for (let i = 0; i < T.maxSupport; i++) { const b = makeSlot('support', i); slotNodes.support.push(b); supportGrid.append(b); }

    // The branch picker, one for the panel, placed under the slot it was opened from.
    const picker = el('div', 'cq-picker');
    picker.hidden = true;
    root.append(picker);
    function openPicker(anchor, kind, i) {
      const unlocked = game.me?.unlocked || [];
      const opts = [];
      const empty = el('button', 'cq-pick-branch', tr('Empty Slot'));
      empty.dataset.branch = '';
      empty.onclick = () => { setSlot(kind, i, null); picker.hidden = true; };
      opts.push(empty);
      for (const b of R.branches) {
        if (kind === 'line' && b.supportOnly) continue;
        const btn = el('button', 'cq-pick-branch');
        btn.dataset.branch = b.id;
        const off = b.locked && !unlocked.includes(b.id);
        btn.append(E.symbol(b.id), el('span', null, ui.text.branch(b.id)));
        if (off) { btn.disabled = true; btn.append(el('span', 'cq-pick-lock', tr('locked'))); btn.title = ui.text.reason('locked-branch'); }
        btn.onclick = () => { setSlot(kind, i, b.id); picker.hidden = true; };
        opts.push(btn);
      }
      picker.replaceChildren(...opts);
      picker.hidden = false;
      const a = anchor.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      picker.style.left = `${Math.max(0, Math.min(a.left - r.left, root.clientWidth - 190))}px`;
      picker.style.top = `${a.bottom - r.top + root.scrollTop + 2}px`;
      picker.dataset.kind = kind;
      picker.dataset.slot = String(i);
    }
    const closePicker = (e) => { if (!picker.hidden && !picker.contains(e.target)) picker.hidden = true; };
    document.addEventListener('pointerdown', closePicker, true);
    function setSlot(kind, i, branch) {
      draft[kind][i] = branch;
      slotMsg.textContent = '';
      slotMsg.classList.remove('bad');
      refresh();
    }

    // ---------- stats, cost, counters ----------
    const statBody = E.section(root, tr('Division'), 'cq-sec-stats');
    const statRows = new Map();
    for (const [k, label] of STATS) {
      const r = el('div', 'cq-stat-row');
      r.dataset.stat = k;
      const v = el('span', 'cq-stat-now');
      const d = el('span', 'cq-stat-delta');
      r.append(el('span', 'cq-eco-label', label()), v, d);
      statBody.append(r);
      statRows.set(k, { r, v, d });
    }
    const costBox = el('div', 'cq-tpl-cost');
    statBody.append(el('div', 'cq-eco-sub', tr('One division costs:')), costBox);
    const checkBody = E.section(root, tr('Counters Check'), 'cq-sec-check');
    const checks = el('div', 'cq-checks');
    checkBody.append(checks);

    // ---------- save ----------
    const saveBody = E.section(root, tr('Save'), 'cq-sec-save');
    const fieldNote = el('div', 'cq-eco-note cq-field-note');
    const saveNew = el('button', 'cq-btn cq-save-new', tr('Save as New'));
    const apply = el('button', 'cq-btn primary cq-apply', tr('Apply'));
    const saveMsg = el('div', 'cq-eco-msg cq-save-msg');
    const saveRow = el('div', 'cq-save-btns');
    saveRow.append(saveNew, apply);
    saveBody.append(fieldNote, saveRow, saveMsg);
    saveNew.onclick = async () => {
      const t = compact(draft);
      const taken = new Set((game.me?.templates || []).map((x) => x.id));
      let id = `t${(game.me?.templates || []).length + 1}`;
      for (let n = 2; taken.has(id); n++) id = `t${(game.me?.templates || []).length + n}`;
      const base = (game.me?.templates || []).find((x) => x.id === selected);
      const tpl = { ...t, id, name: t.name === base?.name ? tr('{name} (new)', { name: t.name }) : t.name };
      const r = await game.order({ type: 'template', template: tpl });
      said(r, tr('Saved as a new template: {name}', { name: tpl.name }));
      if (r.ok) { selected = id; draft = null; }
      update();
    };
    apply.onclick = async () => {
      const r = await game.order({ type: 'template', template: compact(draft) });
      said(r, tr('Applied.'));
      update();
    };
    const said = (r, ok) => { saveMsg.classList.toggle('bad', !r.ok); saveMsg.textContent = r.ok ? ok : ui.text.reason(r.reason); };

    // ---------- training ----------
    const trainBody = E.section(root, tr('Train Divisions'), 'cq-sec-train');
    const trainForm = ui.train.form(trainBody);

    function load(tpl) {
      selected = tpl.id;
      draft = { id: tpl.id, name: tpl.name, line: Array.from({ length: T.maxLine }, (x, i) => tpl.line[i] || null), support: Array.from({ length: T.maxSupport }, (x, i) => (tpl.support || [])[i] || null) };
      name.value = tpl.name;
      saveMsg.textContent = '';
      slotMsg.textContent = '';
      trainForm.setTemplate(tpl.id);
      refresh();
    }

    function drawSlots() {
      for (const kind of ['line', 'support']) {
        draft[kind].forEach((b, i) => {
          const n = slotNodes[kind][i];
          n.dataset.branch = b || '';
          n.classList.toggle('empty', !b);
          n.title = b ? ui.text.branch(b) : tr('Empty slot');
          n.replaceChildren(E.symbol(b));
        });
      }
    }

    async function refresh() {
      if (!draft) return;
      drawSlots();
      const s = ++seq;
      const saved = (game.me?.templates || []).find((x) => x.id === selected) || null;
      const t = compact(draft);
      const uses = [...game.divs.values()].filter((d) => d.nation === game.player && d.tpl === selected).length;
      const changed = !sameTpl(t, saved);
      apply.disabled = !changed || !saved;
      fieldNote.textContent = uses ? tr('Apply changes the {n} divisions of this template already in the field at once: they fight with the new layout straight away, and reinforcement draws the new equipment as they lose strength.', { n: uses })
        : tr('No division uses this template yet.');
      if (!t.line.length) { checks.replaceChildren(el('div', 'cq-check bad', ui.text.reason('too-large'))); return; }
      let now;
      let was;
      let legal;
      let econ;
      try { [now, was, legal, econ] = await Promise.all([E.statsOf(t), saved ? E.statsOf(saved) : null, game.query('legal', { order: { type: 'template', template: t } }), game.query('economy')]); } catch { return; }
      if (s !== seq) return;
      for (const [k, , scale] of STATS) {
        const { r, v, d } = statRows.get(k);
        const a = now[k] | 0;
        const b = was ? was[k] | 0 : a;
        r.dataset.value = String(a);
        r.dataset.delta = String(a - b);
        v.textContent = scale === 1 ? String(a) : (a / scale).toFixed(1);
        const delta = a - b;
        d.textContent = delta ? E.signed(delta / scale, scale === 1 ? 0 : 1) : '';
        d.classList.toggle('good', LOWER_BETTER.has(k) ? delta < 0 : delta > 0);
        d.classList.toggle('bad', LOWER_BETTER.has(k) ? delta > 0 : delta < 0);
      }
      const cost = [el('span', 'cq-cost-item', tr('{n} men', { n: ui.text.number(now.manpower) }))];
      R.items.forEach((it, k) => { if (now.equip[k]) { const c = el('span', 'cq-cost-item', `${ui.text.item(it.id)} ${ui.text.number(now.equip[k])}`); c.dataset.item = it.id; c.dataset.n = String(now.equip[k]); cost.push(c); } });
      costBox.replaceChildren(...cost);
      checks.replaceChildren(...counters(t, now, econ).map(([key, cls, text]) => { const c = el('div', `cq-check ${cls}`, text); c.dataset.check = key; return c; }));
      if (!legal.ok) { saveMsg.classList.add('bad'); saveMsg.textContent = ui.text.reason(legal.reason); }
      else if (saveMsg.classList.contains('bad')) { saveMsg.textContent = ''; saveMsg.classList.remove('bad'); }
    }

    // The plain-language lines of the counters check: [key, 'warn' | 'good' | '', text].
    function counters(t, s, econ) {
      const out = [];
      const count = (b) => t.line.filter((x) => x === b).length;
      const sup = (b) => t.support.filter((x) => x === b).length;
      const inf = count('inf');
      const cav = count('cav') + sup('cav');
      const mg = count('mg');
      const heavy = count('heavy') + sup('heavy');
      const C = R.counters || {};
      const cap = R.combat.counterCap;
      const vsInf = (C.mg || {}).inf | 0;
      const vsCav = (C.mg || {}).cav | 0;
      if (inf) out.push(['mg-inf', 'warn', tr('Each enemy machine-gun battalion takes {p}% off the attack of your {n} infantry battalions (at most {cap}%).', { p: vsInf / 10, n: inf, cap: cap / 10 })]);
      if (mg) out.push(['mg-own', 'good', tr('Your {n} machine-gun battalions take {p}% off an attacking infantry battalion\'s attack.', { n: mg, p: Math.min(cap, mg * vsInf) / 10 })]);
      if (cav) out.push(['mg-cav', 'warn', tr('Cavalry loses {p}% of its attack to each enemy machine-gun battalion: it is fast, but weak against a dug-in line.', { p: vsCav / 10 })]);
      const dig = R.dig.max;
      const left = Math.max(0, dig - s.siege);
      const bonus = Math.trunc((R.combat.dig * left) / 100) / 10;
      if (!heavy) out.push(['no-heavy', 'warn', tr('No heavy artillery: your siege of {siege} leaves defenders in full trenches +{b}% defence.', { siege: s.siege, b: bonus })]);
      else out.push(['heavy', 'good', tr('Heavy artillery: your siege of {siege} cuts the full trench bonus to +{b}%.', { siege: s.siege, b: bonus })]);
      const k = R.items.findIndex((x) => x.id === 'horses');
      const horses = k >= 0 ? s.equip[k] : 0;
      const mud = (R.weather.find((w) => w.id === 'mud') || { supply: 1000 }).supply;
      if (horses) out.push(['mud', horses >= 1000 ? 'warn' : '', tr('{h} horses and a supply use of {s}: in mud supply arrives at {p}%, and horse-drawn units feel it first.', { h: ui.text.number(horses), s: s.supply, p: mud / 10 })]);
      if (s.shells) {
        const stock = game.me?.stock?.shells | 0;
        const prod = econ?.perDay?.shells;
        const hours = Math.trunc(stock / s.shells);
        out.push(['shells', hours < 24 * 30 ? 'warn' : '', prod !== undefined
          ? tr('Fires {n} shells an hour of attack: the stock of {stock} lasts one such division {h} hours; the lines make {p} a day.', { n: s.shells, stock: ui.text.number(stock), h: ui.text.number(hours), p: ui.eco.tenths(prod) })
          : tr('Fires {n} shells an hour of attack: the stock of {stock} lasts one such division {h} hours.', { n: s.shells, stock: ui.text.number(stock), h: ui.text.number(hours) })]);
        if (stock < s.shells * 24) out.push(['no-shells', 'warn', tr('Without shells its artillery attacks at {p}% strength.', { p: R.combat.noShells / 10 })]);
      }
      const slow = R.branches.filter((b) => (t.line.includes(b.id) || t.support.includes(b.id)) && b.speed === s.speed).map((b) => ui.text.branch(b.id));
      out.push(['speed', s.speed < 4000 ? 'warn' : '', tr('Speed {v}, set by its slowest unit ({units}).', { v: (s.speed / 1000).toFixed(1), units: [...new Set(slow)].join(', ') })]);
      return out;
    }

    function drawList() {
      const tpls = game.me?.templates || [];
      const uses = new Map();
      for (const d of game.divs.values()) if (d.nation === game.player) uses.set(d.tpl, (uses.get(d.tpl) || 0) + 1);
      list.replaceChildren(...tpls.map((t) => {
        const r = el('button', `cq-tpl ${t.id === selected ? 'active' : ''}`);
        r.dataset.tpl = t.id;
        const n = el('span', 'cq-tpl-name-text', t.name);
        n.dataset.userText = '';
        const u = el('span', 'cq-tpl-uses', tr('{n} divisions', { n: uses.get(t.id) || 0 }));
        u.dataset.uses = String(uses.get(t.id) || 0);
        r.append(n, u);
        r.onclick = () => { load(t); drawList(); };
        return r;
      }));
    }

    function update() {
      const tpls = game.me?.templates || [];
      if (!draft || !tpls.some((t) => t.id === selected)) {
        const t = tpls.find((x) => x.id === selected) || tpls[0];
        if (t) load(t);
      }
      drawList();
      trainForm.update();
      refresh();
    }
    return { update, destroy() { document.removeEventListener('pointerdown', closePicker, true); }, get draft() { return draft && compact(draft); }, select: (id) => { const t = (game.me?.templates || []).find((x) => x.id === id); if (t) { load(t); drawList(); } } };
  }

  ui.panel({ id: 'designer', title: tr('Division Designer'), icon: 'structure', order: 210, mount });
})();
