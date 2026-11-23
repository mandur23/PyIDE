// The one explaining tooltip of the game screen (Conquest.ui.tip), shared by the resource chips, the province card's
// facts, the army cards and the battle window: show(anchor, { title, rows: [[key, label, text, raw]], note, key }) fills
// it and places it under the anchor (above when there is no room below), hide() hides it, attach(node, build, { focus })
// shows build() on pointer enter and focus and hides it on leave and blur (focus: false for a node inside a button,
// which is not made focusable). Each row carries data-k and data-v (the raw value)
// for tests; the anchor gets aria-describedby while it is shown.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const el = ide.util.el;

  let tip = null;
  let anchor = null;
  function element() {
    const host = document.querySelector('.cq-app') || document.body;
    if (!tip) {
      tip = el('div', 'cq-stat-tip');
      tip.id = 'cq-stat-tip';
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
    }
    if (tip.parentElement !== host) host.append(tip);
    return tip;
  }

  function show(at, { title, rows = [], note = '', key = '' }) {
    const t = element();
    if (anchor && anchor !== at) anchor.removeAttribute('aria-describedby');
    anchor = at;
    const list = rows.map(([k, label, text, raw]) => {
      const r = el('div', 'cq-tip-row');
      r.dataset.k = k;
      r.dataset.v = String(raw ?? text);
      r.append(el('span', 'cq-tip-label', label), el('span', 'cq-tip-value', text));
      return r;
    });
    t.replaceChildren(el('div', 'cq-tip-head', title), ...list, ...(note ? [el('div', 'cq-tip-note', note)] : []));
    t.dataset.stat = key;
    t.hidden = false;
    at.setAttribute('aria-describedby', t.id);
    // A display: contents node (a card fact) has no box of its own: its children's span is the anchor.
    let a = at.getBoundingClientRect();
    if (!a.width && !a.height && at.children.length) {
      const r = [...at.children].map((c) => c.getBoundingClientRect());
      a = { left: Math.min(...r.map((x) => x.left)), top: Math.min(...r.map((x) => x.top)), bottom: Math.max(...r.map((x) => x.bottom)) };
    }
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const below = a.bottom + 6 + h <= window.innerHeight - 4;
    t.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - w - 4))}px`;
    t.style.top = `${below ? a.bottom + 6 : Math.max(4, a.top - h - 6)}px`;
  }

  function hide(at = null) {
    if (!tip || (at && at !== anchor)) return;
    tip.hidden = true;
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
  }

  function attach(node, build, { focus = true, hover = true } = {}) {
    const on = () => { const c = build(); if (c) show(node, c); };
    const off = () => hide(node);
    if (hover) {
      node.addEventListener('mouseenter', on);
      node.addEventListener('mouseleave', off);
    }
    if (focus) {
      node.addEventListener('focus', on);
      node.addEventListener('blur', off);
      if (!node.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(node.tagName)) node.tabIndex = 0;
    }
    return node;
  }

  ui.tip = { show, hide, attach, get anchor() { return anchor; } };
})();
