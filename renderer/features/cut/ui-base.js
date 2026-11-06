// The base every Cut panel builds on (docs/cut-architecture.md section 10): the panel registry the shell mounts into
// its workspaces, the action registry the keyboard dispatcher (ui-keys.js) sends keys through, a pointer drag and
// drop between panels, and the small widgets the panels share (buttons, sliders, scrubbable number fields, timecode
// fields). Cut.ui.start(host, app) comes from ui-shell.js.
//
//   Cut.ui.registerPanel(id, { title: () => string, mount(el, app) -> dispose | { dispose, focus } })
//   Cut.ui.onAction(actionId, fn(ctx) -> false to pass it on, { panels: [panelId] | null })  -> remove()
//   Cut.ui.dnd.start(pointerEvent, payload, { label })   Cut.ui.dnd.target(el, { accepts, over, leave, drop }) -> remove()
//
// Panel ids: project, source, program, timeline, controls, effects, captions, text, color, export, history, meters,
// markers.
//
// Action ids (ui-keys.js binds the keys; each is also the IDE action 'Cut.<id>' for Find Action):
//   transport  playPause shuttleBack shuttleStop shuttleForward frameBack frameForward frameBack5 frameForward5
//              prevEdit nextEdit goStart goEnd goIn goOut
//   marks      markIn markOut markClip clearInOut addMarker
//   editing    insert overwrite lift extract split splitAll rippleStart rippleEnd rippleDelete delete toggleEnabled link
//              group ungroup nudgeLeft nudgeRight nudgeLeft5 nudgeRight5 selectAtPlayhead matchFrame extendEdit speed
//              freezeFrame transitionVideo transitionAudio transitionBoth copy paste pasteInsert selectAll deselect
//   tools      tool.select tool.trackForward tool.trackBackward tool.ripple tool.roll tool.rate tool.razor tool.slip
//              tool.slide tool.pen tool.hand tool.zoom tool.text snap
//   view       zoomIn zoomOut zoomFit fullscreen
//   project    undo redo save saveAs open newProject import export exportFrame
// The monitors handle transport and marks for their own panel (the program monitor also for the timeline); the
// timeline handles editing, tools and zoom. ui-keys.js gives the project-wide ones and defaults for some editing ones.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const log = ide.logger('#cut');

  const el = (tag, cls, text, attrs) => {
    const n = ide.util.el(tag, cls, text);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    return n;
  };

  // Transport and editing glyphs the IDE's icon set has no match for. Constant markup only.
  const svg = (body) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const ICONS = {
    play: svg('<path d="M4.5 3v10l8.5-5z" fill="currentColor"/>'),
    pause: svg('<rect x="4" y="3" width="3" height="10" rx=".5" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx=".5" fill="currentColor"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>'),
    stepBack: svg('<path d="M11.5 3.5v9L5 8z" fill="currentColor"/><rect x="3" y="3.5" width="1.6" height="9" fill="currentColor"/>'),
    stepForward: svg('<path d="M4.5 3.5v9L11 8z" fill="currentColor"/><rect x="11.4" y="3.5" width="1.6" height="9" fill="currentColor"/>'),
    toStart: svg('<path d="M13 3.5v9L8 8z" fill="currentColor"/><path d="M8.5 3.5v9L3.5 8z" fill="currentColor"/><rect x="2" y="3.5" width="1.4" height="9" fill="currentColor"/>'),
    toEnd: svg('<path d="M3 3.5v9L8 8z" fill="currentColor"/><path d="M7.5 3.5v9l5-4.5z" fill="currentColor"/><rect x="12.6" y="3.5" width="1.4" height="9" fill="currentColor"/>'),
    markIn: svg('<path d="M5 2.5v11M5 2.5h5M5 13.5h5" stroke="currentColor" stroke-width="1.6"/>'),
    markOut: svg('<path d="M11 2.5v11M11 2.5H6M11 13.5H6" stroke="currentColor" stroke-width="1.6"/>'),
    goIn: svg('<path d="M3.5 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M13 3.5v9L6 8z" fill="currentColor"/>'),
    goOut: svg('<path d="M12.5 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M3 3.5v9L10 8z" fill="currentColor"/>'),
    insert: svg('<rect x="1.5" y="9" width="5" height="4.5" rx=".5" stroke="currentColor"/><rect x="9.5" y="9" width="5" height="4.5" rx=".5" stroke="currentColor"/><path d="M8 1.5v6M5.5 5 8 7.5 10.5 5" stroke="currentColor" stroke-width="1.3"/>'),
    overwrite: svg('<rect x="1.5" y="9" width="13" height="4.5" rx=".5" stroke="currentColor"/><rect x="5" y="9" width="6" height="4.5" fill="currentColor" opacity=".55"/><path d="M8 1.5v6M5.5 5 8 7.5 10.5 5" stroke="currentColor" stroke-width="1.3"/>'),
    loop: svg('<path d="M3 7V6a2 2 0 0 1 2-2h7M13 9v1a2 2 0 0 1-2 2H4" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 2 12.5 4l-2 2M5.5 14l-2-2 2-2" stroke="currentColor" stroke-width="1.3"/>'),
    playInOut: svg('<path d="M2.5 3v10M13.5 3v10" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 4.5v7L11 8z" fill="currentColor"/>'),
    safe: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke="currentColor"/><rect x="3.5" y="4.5" width="9" height="7" stroke="currentColor" stroke-dasharray="1.5 1.2"/>'),
    fullscreen: svg('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.3"/>'),
    undo: svg('<path d="M5.5 3 2.5 6l3 3" stroke="currentColor" stroke-width="1.3"/><path d="M3 6h6.5a4 4 0 0 1 0 8H7" stroke="currentColor" stroke-width="1.3"/>'),
    redo: svg('<path d="M10.5 3l3 3-3 3" stroke="currentColor" stroke-width="1.3"/><path d="M13 6H6.5a4 4 0 0 0 0 8H9" stroke="currentColor" stroke-width="1.3"/>'),
    save: svg('<path d="M2.5 2.5h9l2 2v9h-11z" stroke="currentColor"/><path d="M5 2.5v3.5h5V2.5M4.5 13.5V9h7v4.5" stroke="currentColor"/>'),
    open: svg('<path d="M1.5 12.5v-9h4l1.5 1.5h6v2" stroke="currentColor"/><path d="M1.5 12.5 3.5 7h11l-2 5.5z" stroke="currentColor"/>'),
    newFile: svg('<path d="M3.5 1.5h6l3 3v10h-9z" stroke="currentColor"/><path d="M8 7v5M5.5 9.5h5" stroke="currentColor"/>'),
    film: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke="currentColor"/><path d="M4.5 2.5v11M11.5 2.5v11M1.5 6h3M1.5 10h3M11.5 6h3M11.5 10h3" stroke="currentColor"/>'),
    audio: svg('<path d="M2 8h1M4.5 5v6M7 3v10M9.5 5.5v5M12 4v8M14 7v2" stroke="currentColor" stroke-width="1.3"/>'),
    image: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1" stroke="currentColor"/><circle cx="5.5" cy="6" r="1.3" fill="currentColor"/><path d="m2 12 4-4 3 3 2-2 3.5 3.5" stroke="currentColor"/>'),
    sequence: svg('<rect x="1.5" y="3.5" width="13" height="9" rx="1" stroke="currentColor"/><path d="M1.5 7h13M1.5 10h13M6 3.5v3.5M10 7v3" stroke="currentColor"/>'),
    bin: svg('<path d="M1.5 4V13h13V5.5H7.5L6 4z" stroke="currentColor"/>'),
    textItem: svg('<path d="M3 3.5h10M8 3.5v9.5M6 13h4" stroke="currentColor" stroke-width="1.4"/>'),
    solid: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" opacity=".8"/>'),
    export: svg('<path d="M8 10V2M5 5l3-3 3 3" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 9v4.5h11V9" stroke="currentColor" stroke-width="1.3"/>'),
    frame: svg('<rect x="2" y="3" width="12" height="9" rx="1" stroke="currentColor"/><circle cx="8" cy="7.5" r="2.2" stroke="currentColor"/><path d="M6 14h4" stroke="currentColor"/>'),
    captions: svg('<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor"/><path d="M7 6.5a2 2 0 1 0 0 3M12 6.5a2 2 0 1 0 0 3" stroke="currentColor"/>'),
    list: svg('<path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3"/>'),
    grid: svg('<rect x="2" y="2" width="5" height="5" rx=".5" stroke="currentColor"/><rect x="9" y="2" width="5" height="5" rx=".5" stroke="currentColor"/><rect x="2" y="9" width="5" height="5" rx=".5" stroke="currentColor"/><rect x="9" y="9" width="5" height="5" rx=".5" stroke="currentColor"/>'),
    offline: svg('<circle cx="8" cy="8" r="6" stroke="currentColor"/><path d="M4 12 12 4" stroke="currentColor" stroke-width="1.3"/>'),
    link: svg('<path d="M6.5 9.5 9.5 6.5M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8" stroke="currentColor" stroke-width="1.3"/>'),
    video: svg('<rect x="1.5" y="4" width="9" height="8" rx="1" stroke="currentColor"/><path d="m10.5 7 4-2.5v7l-4-2.5" stroke="currentColor"/>'),
  };
  const icon = (name, fallback = '') => {
    if (!ICONS[name]) return ide.icon(name, fallback);
    const span = el('span', 'ide-icon cut-icon');
    span.dataset.iconName = name;
    span.innerHTML = ICONS[name];
    return span;
  };

  // ---------- panels ----------
  const panels = new Map();
  const registerPanel = (id, def) => {
    if (!def || typeof def.mount !== 'function') throw new Error(`panel ${id}: mount is required`);
    panels.set(id, { id, ...def });
    ide.emit('cutPanelRegistered', id);
    return def;
  };

  // ---------- actions (what keys and buttons do) ----------
  // Each action id (ui-keys.js lists them) has handlers; a handler registered for some panels runs only while one of
  // them has the keyboard (app.focusPanel), one with panels: null runs whatever has it. The newest handler goes first,
  // and one returning false passes the action to the next.
  const handlers = new Map(); // action id -> [{fn, panels}]
  const onAction = (id, fn, { panels: only = null } = {}) => {
    const entry = { fn, panels: only ? [].concat(only) : null };
    if (!handlers.has(id)) handlers.set(id, []);
    handlers.get(id).unshift(entry);
    return () => { const list = handlers.get(id); const i = list?.indexOf(entry) ?? -1; if (i >= 0) list.splice(i, 1); };
  };
  const handlerFor = (id, panel) => (handlers.get(id) || []).filter((h) => !h.panels || h.panels.includes(panel));
  // ctx: {app, panel, event?, source: 'key' | 'button' | 'menu'}. -> true when a handler took it.
  const runAction = (id, ctx = {}) => {
    const app = ctx.app || Cut.app;
    const panel = ctx.panel !== undefined ? ctx.panel : app?.focusPanel;
    for (const h of handlerFor(id, panel)) {
      try {
        if (h.fn({ ...ctx, app, panel, action: id }) !== false) return true;
      } catch (err) {
        report(err);
        return true;
      }
    }
    return false;
  };
  const hasHandler = (id, panel) => handlerFor(id, panel).length > 0;

  // ---------- feedback ----------
  // Command errors a person can cause carry a fixed English sentence (commands.js): shown translated.
  const errorText = (err) => tr(String(err?.message || err || 'Error'));
  function report(err, { title } = {}) {
    if (!err?.code) log.error(err?.stack || String(err));
    notify(errorText(err), { kind: err?.code ? 'warn' : 'error', title });
  }
  // A short line over the editor that fades (the reason a trim stopped, "Saved"...), and a notification for errors.
  let toastTimer = 0;
  function toast(text, { kind = 'info', ms = 2600 } = {}) {
    const host = document.querySelector('.cut-root');
    if (!host) return;
    let n = host.querySelector(':scope > .cut-toast');
    if (!n) { n = el('div', 'cut-toast'); host.appendChild(n); }
    n.textContent = text;
    n.dataset.kind = kind;
    n.classList.add('shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => n.classList.remove('shown'), ms);
  }
  function notify(text, { kind = 'info', title } = {}) {
    if (kind === 'error' || kind === 'warn') {
      ide.notifications?.notify({ title: title || tr('Video Editor'), text, kind, group: 'Video Editor', raw: true });
    }
    toast(text, { kind });
  }
  // app.history.do with the error shown instead of thrown. -> the result, or null when it failed.
  function exec(app, command) {
    try {
      return app.history.do(command);
    } catch (err) {
      report(err);
      return null;
    }
  }

  // ---------- widgets ----------
  // button({icon, label, title, action, onClick, toggle, pressed, cls, disabled}). With `action` the tooltip shows its
  // shortcut and a click runs it (Cut.ui.runAction) unless onClick is given.
  function button({ icon: name, label, title, action, onClick, toggle = false, pressed = false, cls = '', disabled = false } = {}) {
    const b = el('button', `cut-btn${name && !label ? ' icon-only' : ''}${cls ? ` ${cls}` : ''}`);
    b.type = 'button';
    if (name) b.appendChild(icon(name));
    if (label) b.appendChild(el('span', 'cut-btn-label', label));
    const tip = title || (name && label ? '' : label) || '';
    if (tip) {
      b.setAttribute('aria-label', tip);
      if (action && ide.actions.some((a) => a.id === action)) ide.keymap.tooltip(b, tip, action);
      else { b.title = tip; b.dataset.tooltip = tip; if (action) b.dataset.keymapAction = action; }
    }
    if (toggle) b.setAttribute('aria-pressed', String(!!pressed));
    b.disabled = disabled;
    // Buttons never keep the keyboard: Space would press them again instead of playing.
    b.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    b.addEventListener('click', (e) => {
      if (toggle && !onClick && !action) b.setPressed(!b.pressed);
      if (onClick) onClick(e, b);
      else if (action) runAction(action, { source: 'button', event: e, panel: b.closest('[data-panel]')?.dataset.panel });
    });
    Object.defineProperty(b, 'pressed', { get: () => b.getAttribute('aria-pressed') === 'true' });
    b.setPressed = (on) => b.setAttribute('aria-pressed', String(!!on));
    return b;
  }

  // slider({min, max, step, value, onInput(v), onChange(v), onBegin(), onEnd(v)}): a range input. onBegin/onEnd bracket
  // one drag (app.history.begin/commit, so a drag is one undo step).
  function slider({ min = 0, max = 100, step = 1, value = 0, onInput, onChange, onBegin, onEnd, title, cls = '' } = {}) {
    const input = el('input', `cut-slider${cls ? ` ${cls}` : ''}`);
    Object.assign(input, { type: 'range', min, max, step, value });
    if (title) input.title = title;
    let dragging = false;
    input.addEventListener('pointerdown', () => { dragging = true; onBegin?.(); });
    const end = () => { if (!dragging) return; dragging = false; onEnd?.(Number(input.value)); };
    input.addEventListener('pointerup', end);
    input.addEventListener('lostpointercapture', end);
    input.addEventListener('input', () => onInput?.(Number(input.value)));
    input.addEventListener('change', () => onChange?.(Number(input.value)));
    return input;
  }

  // numberField({value, min, max, step, precision, unit, onChange(v, {final}), onBegin, onEnd, title}): the value as text
  // that is dragged sideways to change it (Shift: 10x, Ctrl: 1/10) and clicked to type a number. -> the element, with
  // .value (get/set) and .disabled.
  function numberField({ value = 0, min = -Infinity, max = Infinity, step = 1, precision, unit = '', onChange, onBegin, onEnd, title, cls = '' } = {}) {
    const digits = precision ?? (String(step).split('.')[1]?.length || 0);
    const wrap = el('span', `cut-number${cls ? ` ${cls}` : ''}`, undefined, { tabindex: 0, role: 'spinbutton' });
    if (title) wrap.title = title;
    const text = el('span', 'cut-number-text');
    const suffix = el('span', 'cut-number-unit', unit);
    wrap.append(text, suffix);
    let current = value;
    let disabled = false;
    const clamp = (v) => Math.min(max, Math.max(min, v));
    const round = (v) => Number(clamp(v).toFixed(digits));
    const show = () => {
      text.textContent = Number.isFinite(current) ? current.toFixed(digits) : '—';
      wrap.setAttribute('aria-valuenow', String(current));
    };
    show();
    let drag = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (disabled || e.button !== 0 || wrap.querySelector('input')) return;
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, start: current, moved: false };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      if (!drag.moved) { drag.moved = true; onBegin?.(); wrap.classList.add('dragging'); }
      const scale = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
      const v = round(drag.start + dx * step * scale);
      if (v !== current) { current = v; show(); onChange?.(v, { final: false }); }
    });
    const up = () => {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      wrap.classList.remove('dragging');
      if (moved) { onChange?.(current, { final: true }); onEnd?.(current); } else edit();
    };
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('lostpointercapture', up);
    wrap.addEventListener('keydown', (e) => {
      if (disabled || e.target !== wrap) return;
      if (e.key === 'Enter') { e.preventDefault(); edit(); }
    });
    function edit() {
      if (disabled) return;
      const input = el('input', 'cut-number-input');
      input.type = 'text';
      input.value = Number.isFinite(current) ? current.toFixed(digits) : '';
      text.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = Number(input.value.replace(',', '.'));
        input.replaceWith(text);
        if (commit && input.value.trim() !== '' && Number.isFinite(v)) {
          const next = round(v);
          if (next !== current) { current = next; show(); onChange?.(next, { final: true }); }
        }
        if (document.activeElement === document.body) wrap.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }
    Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v; show(); } });
    Object.defineProperty(wrap, 'disabled', {
      get: () => disabled,
      set: (v) => { disabled = !!v; wrap.classList.toggle('disabled', disabled); wrap.tabIndex = disabled ? -1 : 0; },
    });
    return wrap;
  }

  // timecodeField({fps: () => [num, den], value, onChange(t), title}): HH:MM:SS:FF, clicked to type a timecode, a frame
  // count, or +N / -N frames from the current value. -> the element with .value (ticks, get/set).
  function timecodeField({ fps, value = 0, onChange, title, cls = '' } = {}) {
    const rate = () => (typeof fps === 'function' ? fps() : fps) || [30, 1];
    const wrap = el('span', `cut-timecode${cls ? ` ${cls}` : ''}`, undefined, { tabindex: 0 });
    if (title) wrap.title = title;
    const text = el('span', 'cut-timecode-text');
    wrap.appendChild(text);
    let current = value;
    const show = () => { text.textContent = Cut.time.timecode(current, rate()); };
    show();
    const edit = () => {
      if (wrap.querySelector('input')) return;
      const input = el('input', 'cut-timecode-input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = text.textContent;
      text.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const t = commit ? Cut.time.parseTimecode(input.value, rate(), current) : null;
        input.replaceWith(text);
        if (t !== null && Number.isFinite(t)) { current = t; show(); onChange?.(t); } else show();
        if (document.activeElement === document.body) wrap.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    };
    wrap.addEventListener('click', edit);
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === wrap) { e.preventDefault(); edit(); } });
    Object.defineProperty(wrap, 'value', { get: () => current, set: (t) => { current = t; if (!wrap.querySelector('input')) show(); } });
    wrap.refresh = show;
    return wrap;
  }

  // A select of [{value, label}] -> the element; .value is the chosen value.
  function select({ options, value, onChange, title, cls = '' } = {}) {
    const s = el('select', `cut-select${cls ? ` ${cls}` : ''}`);
    if (title) s.title = title;
    const fill = (list) => {
      s.replaceChildren(...list.map((o) => el('option', null, o.label, { value: String(o.value) })));
    };
    fill(options || []);
    if (value !== undefined) s.value = String(value);
    s.addEventListener('change', () => onChange?.(s.value));
    s.setOptions = (list, v = s.value) => { fill(list); s.value = String(v); };
    return s;
  }

  // menu(anchor | x, y?, items): the IDE's context menu, below an element or at a point.
  function menu(anchor, y, items) {
    if (anchor instanceof Element) {
      const r = anchor.getBoundingClientRect();
      return ide.ui.contextMenu(r.left, r.bottom + 2, y);
    }
    return ide.ui.contextMenu(anchor, y, items);
  }
  const dialog = (opts) => {
    const dlg = ide.ui.dialog(opts);
    dlg.el.classList.add('cut-dialog');
    if (opts.id) dlg.el.id = opts.id;
    return dlg;
  };
  // A labelled row for forms: row(label, control, hint?).
  const row = (label, control, hint) => {
    const r = el('label', 'cut-form-row');
    r.append(el('span', 'cut-form-label', label), control);
    if (hint) r.appendChild(el('span', 'cut-form-hint', hint));
    return r;
  };

  // virtualList({rowHeight, cls, render(i) -> row element}): a scrolling list that keeps only the rows in view (and a
  // few around them) in the DOM, so a list of thousands of entries stays fast. -> {el, count, setCount(n), refresh(),
  // scrollTo(i), indexAt(clientY)}. Each row gets data-index and its place; render() builds its content.
  function virtualList({ rowHeight = 22, cls = '', render } = {}) {
    const box = el('div', `cut-vlist${cls ? ` ${cls}` : ''}`, undefined, { tabindex: 0 });
    const spacer = el('div', 'cut-vlist-spacer');
    box.appendChild(spacer);
    let count = 0;
    let raf = 0;
    const draw = () => {
      raf = 0;
      spacer.style.height = `${count * rowHeight}px`;
      const h = box.clientHeight || rowHeight * 20;
      const first = Math.max(0, Math.floor(box.scrollTop / rowHeight) - 4);
      const last = Math.min(count, Math.ceil((box.scrollTop + h) / rowHeight) + 4);
      const rows = [];
      for (let i = first; i < last; i++) {
        const r = render(i);
        r.classList.add('cut-vlist-row');
        r.dataset.index = String(i);
        r.style.top = `${i * rowHeight}px`;
        r.style.height = `${rowHeight}px`;
        rows.push(r);
      }
      spacer.replaceChildren(...rows);
    };
    const refresh = () => { if (!raf) raf = requestAnimationFrame(draw); };
    box.addEventListener('scroll', refresh, { passive: true });
    const ro = ide.util.observeSize(box, refresh);
    return {
      el: box,
      get count() { return count; },
      setCount(n) { count = Math.max(0, n | 0); refresh(); },
      refresh,
      // right away, for a caller that reads the rows next
      drawNow() { cancelAnimationFrame(raf); draw(); },
      // Scrolls just enough to show row i.
      scrollTo(i) {
        const top = i * rowHeight;
        if (top < box.scrollTop) box.scrollTop = top;
        else if (top + rowHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + rowHeight - box.clientHeight;
        refresh();
      },
      indexAt(clientY) {
        const i = Math.floor((clientY - box.getBoundingClientRect().top + box.scrollTop) / rowHeight);
        return i >= 0 && i < count ? i : -1;
      },
      dispose() { cancelAnimationFrame(raf); ro?.disconnect?.(); },
    };
  }

  // ---------- typing ----------
  // Keys never act while a person types: in a text field, a contenteditable (a text layer being edited sets
  // Cut.ui.typing too) or while an IME composes.
  const TEXT_INPUTS = new Set(['text', 'search', 'number', 'email', 'password', 'url', 'tel', '']);
  const isTyping = (target = document.activeElement) => {
    if (Cut.ui.typing) return true;
    if (!target || target === document.body) return false;
    if (target.isContentEditable) return true;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    if (target.tagName === 'INPUT') return TEXT_INPUTS.has((target.getAttribute('type') || '').toLowerCase());
    return !!target.closest?.('.monaco-editor');
  };

  // ---------- drag and drop between panels ----------
  // Pointer-driven, not HTML drag and drop: it works with the mouse events tests send, shows our own ghost and never
  // starts an OS drag. payload: {kind: 'media', ids: [mediaId]} | {kind: 'source', mediaId, in, out, video, audio}
  // | {kind: 'sequence', id} | {kind: 'effect', type} | {kind: 'transition', type}. Targets get (payload, event, info)
  // where info.ctrl / info.alt are the modifier keys at that moment.
  const targets = new Set();
  const dnd = {
    active: null,
    target(node, spec) {
      const t = { node, ...spec };
      targets.add(t);
      return () => targets.delete(t);
    },
    // Call from a pointerdown; the drag begins once the pointer moved 4 px, so a click stays a click.
    start(down, payload, { label = '', onEnd } = {}) {
      if (down.button !== 0) return;
      const x0 = down.clientX, y0 = down.clientY;
      let ghost = null;
      let over = null;
      const info = (e) => ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, x: e.clientX, y: e.clientY });
      const find = (e) => {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        return [...targets].reverse().find((t) => t.node.isConnected && t.node.contains(hit) && (!t.accepts || t.accepts(payload, e))) || null;
      };
      const move = (e) => {
        if (!ghost) {
          if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
          ghost = el('div', 'cut-drag-ghost', label || '');
          document.body.appendChild(ghost);
          dnd.active = payload;
          document.body.classList.add('cut-dragging');
        }
        ghost.style.left = `${e.clientX + 12}px`;
        ghost.style.top = `${e.clientY + 10}px`;
        const t = find(e);
        if (t !== over) { over?.leave?.(payload, e); over = t; }
        over?.over?.(payload, e, info(e));
      };
      const finish = (e, drop) => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        removeEventListener('keydown', key, true);
        if (!ghost) return;
        ghost.remove();
        document.body.classList.remove('cut-dragging');
        dnd.active = null;
        const t = drop ? find(e) : null;
        if (over && over !== t) over.leave?.(payload, e);
        if (t) {
          try { t.drop?.(payload, e, info(e)); } catch (err) { report(err); }
          t.leave?.(payload, e);
        }
        onEnd?.(!!t);
      };
      const up = (e) => finish(e, true);
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e, false); } };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
      addEventListener('keydown', key, true);
    },
  };

  // ---------- editing state shared by the screen (not saved in the project) ----------
  // patch: the source patch, the tracks a source clip goes to (null = that half is not placed); the timeline's track
  // headers show and change it. snapping: S. Each setter emits an app event: 'patch' {video, audio}, 'snapping' {on}.
  const editing = { patch: { video: 'V1', audio: 'A1' }, snapping: true };
  const setPatch = (app, patch) => {
    editing.patch = { ...editing.patch, ...patch };
    app?.emit('patch', { ...editing.patch });
  };
  const setSnapping = (app, on) => {
    editing.snapping = !!on;
    app?.emit('snapping', { on: editing.snapping });
  };
  // The patch checked against the active sequence: a track that is gone falls back to the first of its kind.
  const patchFor = (app) => {
    const seq = app?.sequence;
    if (!seq) return { video: null, audio: null };
    const pick = (kind, id) => (id === null ? null : seq.tracks.find((t) => t.id === id && t.kind === kind)?.id
      ?? seq.tracks.find((t) => t.kind === kind)?.id ?? null);
    return { video: pick('video', editing.patch.video), audio: pick('audio', editing.patch.audio) };
  };

  // ---------- small helpers ----------
  const fpsOf = (app) => app?.sequence?.fps || [30, 1];
  const formatDuration = (ticks, fps = [30, 1]) => Cut.time.timecode(ticks || 0, fps);
  const formatBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  };
  const basename = (p) => String(p || '').split(/[\\/]/).pop();

  Object.assign((Cut.ui = Cut.ui || {}), {
    panels,
    registerPanel,
    onAction,
    runAction,
    hasHandler,
    el,
    icon,
    icons: ICONS,
    button,
    slider,
    numberField,
    timecodeField,
    select,
    menu,
    dialog,
    row,
    virtualList,
    confirm: (text, opts) => ide.ui.confirm(text, opts),
    isTyping,
    typing: false,
    dnd,
    editing,
    setPatch,
    setSnapping,
    patchFor,
    exec,
    report,
    errorText,
    toast,
    notify,
    fpsOf,
    formatDuration,
    formatBytes,
    basename,
  });
})();
