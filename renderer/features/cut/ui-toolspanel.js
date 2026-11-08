// The Tools panel (panel id 'tools'): Premiere Pro's vertical tool bar beside the timeline. The tools come in Premiere's
// groups (Selection; Track Select Forward and Backward; Ripple, Rolling and Rate Stretch; Razor; Slip and Slide; Pen;
// Hand and Zoom; Type). A group's button shows the tool of that group used last (kept in `cut.toolGroups`); a small
// corner mark says the group has more. Holding the button down (or a right-click) opens the group's flyout, which
// lists its tools with their keys; a key of a tool in the group (B, N, R...) also shows that tool on the button.
// Clicking a tool hands the keyboard back to the panel that had it, so Delete and the arrows still reach the timeline.
// The panel lies down (a row) when it is wider than tall. The tools and glyphs are the timeline's (ui.timelineTools).
//
// Cut.ui.toolsPanel: { GROUPS, openFlyout(group), closeFlyout(), get flyout }
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el } = ui;

  const GROUPS = [['select'], ['trackForward', 'trackBackward'], ['ripple', 'roll', 'rate'], ['razor'], ['slip', 'slide'], ['pen'], ['hand', 'zoom'], ['text']];
  const KEY = 'cut.toolGroups';
  const HOLD_MS = 350;
  const toolDef = (id) => (ui.timelineTools?.list || []).find((t) => t.id === id) || { id, title: id };
  const glyph = (id) => ui.timelineTools?.icon?.(id) || el('span', 'ide-icon');
  const groupOf = (tool) => GROUPS.findIndex((g) => g.includes(tool));
  const savedGroups = () => { const v = ide.settings.get(KEY, null); return Array.isArray(v) ? v : []; };

  let flyout = null; // {box, group, close}
  function closeFlyout() {
    if (!flyout) return;
    const f = flyout;
    flyout = null;
    f.close();
  }

  let current = null; // the mounted panel's API
  function mount(host, app) {
    const root = el('div', 'cut-tools', undefined, { role: 'toolbar', 'aria-label': tr('Tools') });
    host.appendChild(root);
    const shown = GROUPS.map((g, i) => (g.includes(savedGroups()[i]) ? savedGroups()[i] : g[0]));
    // the panel that had the keyboard before this one: it gets it back after a click here
    let before = app.focusPanel && app.focusPanel !== 'tools' ? app.focusPanel : 'timeline';
    const offs = [app.on('focus', () => { if (app.focusPanel && app.focusPanel !== 'tools') before = app.focusPanel; })];
    const giveBack = () => { if (app.focusPanel === 'tools') ui.focusPanel?.(before); };

    const buttons = GROUPS.map((g, i) => {
      const b = el('button', `cut-tools-btn${g.length > 1 ? ' group' : ''}`, undefined, { type: 'button', 'data-group': String(i) });
      if (g.length > 1) b.setAttribute('aria-haspopup', 'menu');
      let timer = 0;
      let opened = false;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        opened = false;
        clearTimeout(timer);
        if (g.length > 1) timer = setTimeout(() => { timer = 0; opened = true; openFlyout(i); }, HOLD_MS);
      });
      b.addEventListener('pointerup', (e) => {
        if (e.button !== 0) return;
        if (timer) { clearTimeout(timer); timer = 0; }
        if (opened) return;
        app.setTool(shown[i]);
        giveBack();
      });
      b.addEventListener('pointerleave', () => { if (timer) { clearTimeout(timer); timer = 0; } });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (g.length > 1) openFlyout(i); });
      // the keyboard (Tab to it, then Enter or Space) picks the shown tool; ArrowRight opens the flyout
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' && g.length > 1) { e.preventDefault(); openFlyout(i); }
      });
      b.addEventListener('click', (e) => { if (e.detail === 0) app.setTool(shown[i]); });
      root.appendChild(b);
      return b;
    });

    function paint() {
      buttons.forEach((b, i) => {
        const id = shown[i];
        if (b.dataset.tool !== id) {
          b.dataset.tool = id;
          b.replaceChildren(glyph(id));
          if (GROUPS[i].length > 1) b.appendChild(el('span', 'cut-tools-more'));
          ide.keymap.tooltip(b, tr(toolDef(id).title), `Cut.tool.${id}`);
          b.setAttribute('aria-label', tr(toolDef(id).title));
        }
        b.setAttribute('aria-pressed', String(app.tool === id));
      });
    }
    // A tool picked anywhere (its key, the timeline bar, the flyout) is shown on its group's button.
    offs.push(app.on('tool', ({ tool }) => {
      const gi = groupOf(tool);
      if (gi >= 0 && shown[gi] !== tool) {
        shown[gi] = tool;
        ide.settings.set(KEY, shown.slice());
      }
      paint();
    }));

    function openFlyout(gi) {
      closeFlyout();
      const btn = buttons[gi];
      if (!btn?.isConnected) return null;
      const box = el('div', 'cut-tools-flyout', undefined, { role: 'menu', 'data-group': String(gi) });
      for (const id of GROUPS[gi]) {
        const row = el('div', 'cut-tools-flyout-item', undefined, { role: 'menuitemradio', 'data-tool': id, 'aria-checked': String(app.tool === id), tabindex: -1 });
        row.append(glyph(id), el('span', 'cut-tools-flyout-name', tr(toolDef(id).title)), el('span', 'cut-tools-flyout-key', ide.keymap.hint(`Cut.tool.${id}`)));
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => { closeFlyout(); app.setTool(id); giveBack(); });
        box.appendChild(row);
      }
      (document.querySelector('.cut-root') || document.body).appendChild(box);
      // beside the button, inside the window
      const r = btn.getBoundingClientRect();
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      const left = r.right + 4 + bw > innerWidth - 4 ? Math.max(4, r.left - bw - 4) : r.right + 4;
      box.style.left = `${left}px`;
      box.style.top = `${Math.max(4, Math.min(r.top, innerHeight - bh - 4))}px`;
      btn.classList.add('open');
      const outside = (e) => { if (!box.contains(e.target) && !btn.contains(e.target)) closeFlyout(); };
      const keys = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFlyout(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const rows = [...box.children];
          const i = rows.indexOf(document.activeElement);
          rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
        } else if (e.key === 'Enter' && box.contains(document.activeElement)) {
          e.preventDefault();
          e.stopPropagation();
          document.activeElement.click();
        }
      };
      addEventListener('pointerdown', outside, true);
      addEventListener('keydown', keys, true);
      addEventListener('blur', closeFlyout);
      flyout = {
        box, group: gi,
        close: () => {
          box.remove();
          btn.classList.remove('open');
          removeEventListener('pointerdown', outside, true);
          removeEventListener('keydown', keys, true);
          removeEventListener('blur', closeFlyout);
        },
      };
      return box;
    }

    paint();
    current = { openFlyout, buttons };
    return {
      dispose() {
        closeFlyout();
        for (const off of offs) off();
        root.remove();
        if (current?.buttons === buttons) current = null;
      },
      focus() { buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.focus({ preventScroll: true }) || host.closest('.cut-panel')?.focus({ preventScroll: true }); },
    };
  }

  ui.toolsPanel = {
    GROUPS,
    openFlyout: (gi) => current?.openFlyout(gi) || null,
    closeFlyout,
    get flyout() { return flyout ? { group: flyout.group, el: flyout.box } : null; },
  };
  ui.registerPanel('tools', { title: () => tr('Tools'), mount });
})();
