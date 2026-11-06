// The history panel (video-editor-features.md section 17 [2]): the project's undo steps, oldest first, under the state
// the project started from. The current point is marked; the steps after it (those Redo would do again) are dimmed. A
// click on a step undoes or redoes to just after it in one go (history.goTo); a click on the first row goes back to
// the start. The list follows every edit, undo, redo and committed group (the app's 'history' event) and keeps only
// the rows in view in the DOM, so a history of thousands of steps scrolls and updates at once.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { el } = ui;
  const ROW = 22;

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-history');
    let steps = [];
    let position = 0;
    const list = ui.virtualList({ rowHeight: ROW, cls: 'cut-history-list', render });
    list.el.setAttribute('role', 'listbox');
    list.el.setAttribute('aria-label', tr('History'));
    const foot = el('div', 'cut-panel-foot cut-history-foot');
    root.append(list.el, foot);
    host.appendChild(root);

    // Row 0 is the start; row i (1..n) is the state after step i.
    function render(i) {
      const label = i === 0 ? tr('Start') : tr(steps[i - 1].label);
      const r = el('div', 'cut-history-row', undefined, { role: 'option' });
      const mark = el('span', 'cut-history-mark');
      const text = el('span', 'cut-history-label', label);
      r.append(mark, text);
      r.title = label;
      if (i === 0) r.classList.add('start');
      if (i === position) { r.classList.add('current'); r.setAttribute('aria-selected', 'true'); }
      if (i > position) r.classList.add('undone');
      return r;
    }
    function refresh() {
      const h = app.history;
      steps = h ? h.list() : [];
      position = h ? h.position ?? steps.filter((x) => x.done).length : 0;
      list.setCount(steps.length + 1);
      list.drawNow();
      list.scrollTo(position);
      const redo = steps.length - position;
      foot.textContent = redo ? tr('{n} steps, {m} undone', { n: steps.length, m: redo }) : tr('{n} steps', { n: steps.length });
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(() => cancelAnimationFrame(raf));

    list.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const i = list.indexAt(e.clientY);
      if (i < 0 || !app.history) return;
      e.preventDefault();
      list.el.focus({ preventScroll: true });
      if (app.history.goTo(i)) refresh();
    });
    // Up and Down step through the list like Undo and Redo.
    list.el.addEventListener('keydown', (e) => {
      if (!app.history || e.ctrlKey || e.altKey || e.metaKey) return;
      const to = { ArrowUp: position - 1, ArrowDown: position + 1, Home: 0, End: steps.length }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (app.history.goTo(to)) refresh();
    });

    offs.push(app.on('history', later));
    refresh();
    ui.history = {
      get rows() { return steps.length + 1; },
      get position() { return position; },
      rowRect: (i) => {
        list.scrollTo(i);
        list.drawNow();
        return list.el.querySelector(`.cut-history-row[data-index="${i}"]`)?.getBoundingClientRect() || null;
      },
      refresh,
    };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } list.dispose(); root.remove(); },
      focus() { list.el.focus({ preventScroll: true }); },
    };
  }

  ui.registerPanel('history', { title: () => tr('History'), mount });
})();
