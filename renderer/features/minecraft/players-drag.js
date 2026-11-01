// Dragging in the Players tab's inventory: a stack to another slot (a filled one swaps), an item from the list onto a slot,
// a stack to the trash. Only on a live inventory: tiles are 'editable' only then. Nothing here decides whether a move is
// safe: main re-reads the slots and refuses what changed. A drag is pointer events, not HTML drag and drop, which gives no
// way to draw over the app or to tell Escape from a drop elsewhere.
//
// Drag {v, source: {key, slot} | {item}, node, x, y, pointer, live, target, ghost, held}: live once the pointer has really
// moved, before which a press is still a click on the tile. held: a detail that came during the drag, shown at its end.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const { call, views, act, canEdit, showDetail, hideTip, moveSlot, shownIn, slotLabel, slotItem, choice, choiceIcon, numberInput, field, later, userText } = mc.players.kit;
  const START_PX = 4;
  const ROWS = 40;
  let drag = null;

  function press(e, v, source, node) {
    if (e.button !== 0 || drag || v.acting) return;
    drag = { v, source, node, x: e.clientX, y: e.clientY, pointer: e.pointerId, live: false, target: null, ghost: null, held: null };
    v.drag = drag;
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', release, true);
    addEventListener('pointercancel', abort, true);
    addEventListener('keydown', key, true);
    addEventListener('blur', abort);
  }
  function lift() {
    drag.live = true;
    hideTip();
    const ghost = el('div', 'mcpl-ghost');
    ghost.append(...[...drag.node.children].map((n) => n.cloneNode(true)));
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.node.classList.add('dragging');
    document.body.classList.add('mcpl-dragging');
  }
  function place(x, y) {
    drag.ghost.style.transform = `translate(${x + 8}px, ${y + 8}px)`;
    const under = document.elementFromPoint(x, y);
    const spot = under?.closest('.mcpl-tile.editable, .mcpl-trash') ?? null;
    const usable = spot && drag.v.host.contains(spot) && spot !== drag.node && !(drag.source.item && spot.matches('.mcpl-trash'));
    const target = usable ? spot : null;
    if (target === drag.target) return;
    drag.target?.classList.remove('drop');
    target?.classList.add('drop');
    drag.target = target;
  }
  function move(e) {
    if (e.pointerId !== drag.pointer) return;
    if (!drag.live) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < START_PX) return;
      lift();
    }
    e.preventDefault();
    place(e.clientX, e.clientY);
  }
  // The press and release of a drag end in a click on whatever is under both, which must not open that slot's dialog.
  function swallowClick() {
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', stop, { capture: true }), 0);
  }
  function finish() {
    const d = drag;
    drag = null;
    d.v.drag = null;
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', release, true);
    removeEventListener('pointercancel', abort, true);
    removeEventListener('keydown', key, true);
    removeEventListener('blur', abort);
    d.ghost?.remove();
    d.node.classList.remove('dragging');
    d.target?.classList.remove('drop');
    document.body.classList.remove('mcpl-dragging');
    return d;
  }
  const showHeld = (d) => { if (d.held && views.has(d.v)) showDetail(d.v, d.held); };
  // The move goes out before the detail held back is shown: it must say what the tab showed when the owner let go, or
  // main would compare a slot with the very read that changed it.
  function release(e) {
    if (e.pointerId !== drag.pointer) return;
    const d = finish();
    if (d.live) {
      swallowClick();
      if (d.target) dropped(d, d.target);
    }
    showHeld(d);
  }
  function abort() { if (drag) showHeld(finish()); }
  function key(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    abort();
  }

  // What the tab showed when the drag began is what main compares, so a refresh held back cannot make a move look current.
  function dropped({ v, source }, target) {
    if (target.matches('.mcpl-trash')) { trash(v, source.key); return; }
    const to = Number(target.dataset.key);
    if (source.key === undefined) placeItem(v, source.item, source.count(), to);
    else moveSlot(v, source.key, to);
  }
  function trash(v, key) {
    const stack = shownIn(v, key);
    if (!stack) return;
    const slot = slotLabel(key);
    act(v, { type: 'moveItem', op: 'clear', from: key, shown: { from: stack.print } }, {
      ask: (name) => tr('Throw away what {name} holds in {slot}? It is gone for good.', { slot, name }), ok: tr('Throw Away'), what: { item: slotItem(v, stack), slot },
    });
  }
  function placeItem(v, item, count, to) {
    const there = shownIn(v, to);
    const slot = slotLabel(to);
    act(v, { type: 'moveItem', op: 'place', to, item: item.id, count, shown: { to: there?.print ?? null } }, {
      ...(there && { ask: (name) => tr('Replace what {name} holds in {slot}? It is gone for good.', { slot, name }), ok: tr('Replace') }), what: { item: item.title, slot },
    });
  }

  // The list of items to drag in, the count they come with, and the trash. Shown only while the inventory can be edited.
  function tools(v) {
    const box = el('div', 'mcpl-inv-tools hidden');
    const q = el('input', 'input mcpl-palette-find');
    q.placeholder = tr('Search items to drag in');
    q.spellcheck = false;
    const count = numberInput('mcpl-palette-count', 1, 64, '1');
    const rows = el('div', 'mcpl-palette-list');
    rows.addEventListener('dragstart', (e) => e.preventDefault());
    const note = el('div', 'mcpl-palette-note muted', tr('Type to find an item, then drag it onto a slot.'));
    let seq = 0;
    const search = later(async () => {
      const mine = ++seq;
      const text = q.value.trim();
      if (!text) { rows.replaceChildren(); return; }
      let r;
      try { r = await call('items', v, text); } catch { r = { items: [] }; }
      if (mine !== seq || !views.has(v)) return;
      note.textContent = r.items.length ? tr('Drag an item onto a slot.') : tr('No item matches that.');
      rows.replaceChildren(...r.items.slice(0, ROWS).map(choice).map((c) => {
        const row = el('div', 'mcpl-palette-row');
        row.dataset.id = c.id;
        row.append(choiceIcon(c), userText('span', 'mcpl-pick-name', c.title));
        row.onpointerdown = (e) => press(e, v, { item: c, count: () => (count.value.trim() === '' ? 1 : Number(count.value)) }, row);
        return row;
      }));
    }, 150);
    q.oninput = search;
    const trashcan = el('div', 'mcpl-trash', tr('Drop here to throw away'));
    const side = el('div', 'mcpl-palette');
    const line = el('div', 'mcpl-palette-line');
    line.append(q, field(tr('Count'), count));
    side.append(line, note, rows);
    box.append(side, trashcan);
    return box;
  }

  // The tiles come and go with each paint, so the press is caught on the body they live in. An icon is an image, which the
  // browser would start dragging by itself, ending the pointer's events and waking the editor's drop zones.
  function watch(v) {
    v.invBody.addEventListener('dragstart', (e) => e.preventDefault());
    v.invBody.addEventListener('pointerdown', (e) => {
      const tile = e.target.closest('.mcpl-tile.editable.filled');
      if (!tile || !canEdit(v)) return;
      const key = Number(tile.dataset.key);
      press(e, v, { key, slot: shownIn(v, key) }, tile);
    });
  }

  mc.players.drag = {
    tools(v) { watch(v); return tools(v); },
    // A player gone, a server stopped, another player chosen: whatever was being dragged is no longer on offer.
    cancel(v) { if (drag?.v === v) abort(); },
  };
})();
