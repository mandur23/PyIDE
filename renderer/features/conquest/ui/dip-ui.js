// Conquest.ui.dip: what the diplomacy panel, the judgment panel and the end screen share. The nation they look at
// (selected, set by a click in either panel or on the map in the diplomacy mode, heard as ui.events 'dip-select'),
// rendering of translated text with clickable province names (text.js parts), trust and grudge meters, a list that
// keeps only its visible rows in the DOM, and opening a dock panel by its tab.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const game = Conquest.game;

  const dip = (ui.dip = {
    selected: null,
    select(n) {
      if (!Number.isInteger(n) || n < 0 || n === dip.selected) return;
      dip.selected = n;
      ui.events.emit('dip-select', n);
    },
  });

  dip.focusProvince = (id) => {
    const view = ui.shell.view;
    if (!view || !(id > 0)) return;
    view.focus(id);
    view.setSelected(id);
    game.setSelection({ province: id });
  };

  // Opens a dock panel (the shell toggles on its tab, so only a closed one is clicked).
  dip.openPanel = (id) => {
    const tab = document.querySelector(`.cq-dock-tab[data-panel="${id}"]`);
    if (tab && !tab.classList.contains('active')) tab.click();
  };

  // [{ text, province?, nation? }] -> a span; provinces are buttons that focus the map.
  dip.partsEl = (parts, cls = '') => {
    const span = el('span', cls || null);
    for (const p of parts) {
      if (p.province > 0) {
        const b = el('button', 'cq-dip-link', p.text);
        b.dataset.province = String(p.province);
        b.dataset.userText = '';
        b.onclick = (e) => { e.stopPropagation(); dip.focusProvince(p.province); };
        span.append(b);
      } else if (p.nation !== undefined) {
        const s = el('span', 'cq-dip-name', p.text);
        if (game.source === 'generated') s.dataset.userText = '';
        span.append(s);
      } else span.append(document.createTextNode(p.text));
    }
    return span;
  };

  // A nation's name as an element: a generated map's names are data, not UI text.
  dip.nameEl = (n, cls = 'cq-dip-name') => {
    const s = el('span', cls, game.nationName(n));
    if (game.source === 'generated') s.dataset.userText = '';
    return s;
  };
  dip.chip = (n) => {
    const c = el('span', 'cq-chip');
    c.style.background = game.scenario?.nations[n]?.color || '#888';
    return c;
  };

  // kind 'trust' (-1000..1000, centred) or 'grudge' (0..1000).
  dip.meter = (kind) => {
    const box = el('div', `cq-dip-meter cq-dip-meter-${kind}`);
    const label = el('span', 'cq-dip-meter-label', kind === 'trust' ? tr('Trust') : tr('Grudge'));
    const track = el('span', 'cq-dip-meter-track');
    const fill = el('span', 'cq-dip-meter-fill');
    track.append(fill);
    const value = el('span', 'cq-dip-meter-value');
    box.append(label, track, value);
    return {
      el: box,
      set(v) {
        v = v | 0;
        box.dataset.value = String(v);
        value.textContent = kind === 'trust' ? ui.text.signed(v) : ui.text.score(v);
        if (kind === 'trust') {
          const w = Math.min(50, Math.abs(v) / 20);
          fill.style.left = `${v >= 0 ? 50 : 50 - w}%`;
          fill.style.width = `${w}%`;
          fill.classList.toggle('neg', v < 0);
        } else {
          fill.style.left = '0';
          fill.style.width = `${Math.min(100, Math.max(0, v) / 10)}%`;
        }
      },
    };
  };

  // A scrolling box of fixed-height rows that keeps only the visible ones (and a few around them) in the DOM.
  dip.vlist = (cls, rowH, renderRow) => {
    const box = el('div', `cq-dip-vlist ${cls}`);
    const inner = el('div', 'cq-dip-vlist-inner');
    box.append(inner);
    let items = [];
    let first = -1;
    let last = -1;
    const draw = (force) => {
      const h = box.clientHeight || rowH * 8;
      const a = Math.max(0, Math.floor(box.scrollTop / rowH) - 4);
      const b = Math.min(items.length, Math.ceil((box.scrollTop + h) / rowH) + 4);
      if (!force && a === first && b === last) return;
      first = a;
      last = b;
      const rows = [];
      for (let i = a; i < b; i++) {
        const r = renderRow(items[i], i);
        r.style.top = `${i * rowH}px`;
        r.style.height = `${rowH}px`;
        r.classList.add('cq-dip-vrow');
        rows.push(r);
      }
      inner.replaceChildren(...rows);
    };
    box.addEventListener('scroll', () => draw(false));
    ide.util.observeSize(box, () => draw(true));
    return {
      el: box,
      get items() { return items; },
      set(list) {
        items = list;
        inner.style.height = `${items.length * rowH}px`;
        draw(true);
      },
      scrollTo(i) { box.scrollTop = Math.max(0, i * rowH - rowH * 2); draw(false); },
    };
  };

  dip.date = (hour) => ui.text.date(game.date(hour));

  // An enemy to look at when nothing is picked: a major at war with us, else any enemy, else a major neighbour.
  dip.mainEnemy = () => {
    const sc = game.scenario?.nations || [];
    const alive = game.nations.filter((x) => x.alive && x.index !== game.player);
    const war = alive.filter((x) => x.war);
    const pick = war.find((x) => sc[x.index]?.major) || war[0] || alive.find((x) => sc[x.index]?.major) || alive[0];
    return pick ? pick.index : null;
  };
})();
