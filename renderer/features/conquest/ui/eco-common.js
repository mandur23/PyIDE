// What the economy and army screens share (ui/panel-production.js, ui/panel-designer.js, ui/eco-train.js):
// Conquest.ui.eco = { symbol(branch) -> <svg> (the branch's map symbol: a framed box with the mark of its arm, drawn in
// currentColor), stepper({ value, min, max, onSet }) -> { el, set(v), input } (- / number / +; onSet(v) on a click
// or Enter), tenths(n) -> "12.5", signed(n, digits) -> "+3" / "−2" / "0", section(root, title) -> body, row(label,
// value) -> el, statsOf(template) -> Promise<stats> (the `stats` query, with counts and equip as arrays) and ITEMS (the
// rules' item ids in order) }. Nothing here posts orders.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const el = ide.util.el;
  const tr = Conquest.ui.text.tr;
  const game = Conquest.game;
  const NS = 'http://www.w3.org/2000/svg';

  const svg = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  // Each mark inside a 24×16 frame: [tag, attrs], in the frame's own coordinates.
  const MARKS = {
    inf: [['path', { d: 'M3 2 L21 14 M21 2 L3 14' }]],
    cav: [['path', { d: 'M3 14 L21 2' }]],
    art: [['circle', { cx: 12, cy: 8, r: 3, fill: 'currentColor' }]],
    heavy: [['circle', { cx: 8.5, cy: 8, r: 2.6, fill: 'currentColor' }], ['circle', { cx: 15.5, cy: 8, r: 2.6, fill: 'currentColor' }]],
    mg: [['path', { d: 'M3 2 L21 14 M21 2 L3 14' }], ['path', { d: 'M8 14 L12 10 L16 14' }]],
    eng: [['path', { d: 'M6 11 V5 H18 V11 M12 5 V11' }]],
    tank: [['rect', { x: 6, y: 5, width: 12, height: 6, rx: 3 }]],
    air: [['path', { d: 'M5 5 Q12 13 12 8 Q12 3 19 11 M5 11 Q12 3 12 8 Q12 13 19 5' }]],
  };
  function symbol(branch) {
    const s = svg('svg', { viewBox: '0 0 24 16', width: 24, height: 16, class: `cq-sym cq-sym-${branch || 'empty'}`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 });
    s.setAttribute('aria-hidden', 'true');
    s.append(svg('rect', { x: 0.7, y: 0.7, width: 22.6, height: 14.6, rx: 1.5 }));
    for (const [tag, attrs] of MARKS[branch] || []) s.append(svg(tag, attrs));
    return s;
  }

  function stepper({ value = 0, min = 0, max = 9999, onSet, cls = '' }) {
    const box = el('span', `cq-stepper ${cls}`);
    const minus = el('button', 'cq-icon-btn cq-step-minus', '−');
    const plus = el('button', 'cq-icon-btn cq-step-plus', '+');
    minus.title = tr('Fewer');
    plus.title = tr('More');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'cq-input cq-step-value';
    input.min = String(min);
    input.max = String(max);
    let cur = value;
    const set = (v) => { cur = v; input.value = String(v); };
    set(value);
    const commit = (v) => { const n = Math.max(min, Math.min(max, Math.trunc(Number(v)))); if (Number.isFinite(n)) onSet?.(n); else set(cur); };
    minus.onclick = () => commit(cur - 1);
    plus.onclick = () => commit(cur + 1);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(input.value); } };
    input.onchange = () => commit(input.value);
    box.append(minus, input, plus);
    return { el: box, input, set, get value() { return cur; }, setMax(m) { max = m; input.max = String(m); } };
  }

  const tenths = (n) => (n % 10 === 0 ? String(n / 10) : (n / 10).toFixed(1));
  const signed = (n, digits = 0) => {
    const v = digits ? Number(n.toFixed(digits)) : Math.round(n);
    return v > 0 ? `+${digits ? v.toFixed(digits) : v}` : v < 0 ? `−${digits ? Math.abs(v).toFixed(digits) : Math.abs(v)}` : '0';
  };

  function section(root, title, cls = '') {
    const s = el('section', `cq-eco-section ${cls}`);
    const h = el('div', 'cq-eco-head', title);
    const body = el('div', 'cq-eco-body');
    s.append(h, body);
    root.append(s);
    return body;
  }
  function row(label, value, cls = '') {
    const r = el('div', `cq-eco-row ${cls}`);
    r.append(el('span', 'cq-eco-label', label), el('span', 'cq-eco-value', value));
    return r;
  }

  // The stats query answers typed arrays as objects keyed by index; this gives arrays back.
  const asArray = (o, n) => Array.from({ length: n }, (x, i) => (o && o[i]) | 0);
  async function statsOf(template) {
    const s = await game.query('stats', { template });
    return { ...s, counts: asArray(s.counts, game.rules.branches.length), equip: asArray(s.equip, game.rules.items.length) };
  }

  ui.eco = { symbol, stepper, tenths, signed, section, row, statsOf, get ITEMS() { return game.rules ? game.rules.items.map((x) => x.id) : []; } };
})();
