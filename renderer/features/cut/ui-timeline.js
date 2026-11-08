// The timeline panel of Nano Studio Cut (docs/cut-architecture.md section 10): the sequence tabs, the tools, the track
// headers (source patch, targeting, lock, sync lock, eye, mute, solo), the ruler with In/Out and markers, the clips with
// thumbnail strips, waveforms and a keyframe line, transitions on edit points, and the playhead. Clips are drawn on a
// canvas (the base layer, redrawn when the project or the view changes) under a second canvas for what moves every
// frame (the playhead, ghosts, the snap guide, the marquee), so 500 clips scroll and drag at frame rate.
//
// Edits are commands (commands.js) built from the gestures: a move is one command on release (the drag shows ghosts),
// a trim or a fade is applied live inside a history group (begin/cancel/do, commit on release), so the program
// monitor shows the edit while dragging and the clamp reason comes from the command itself. Everything is one undo step.
//
// Also here, for the other panels of this area (ui-controls, ui-effects, ui-text, ui-color, ui-overlay):
// Cut.ui.edit, the helpers that read and write a clip's properties at the playhead (keyframes included), and
// Cut.ui.timeline, what the keys and the tests call.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { time, model, keyframes: K } = Cut;
  const C = Cut.commands;
  const T = time.TICKS;
  const log = ide.logger('#cut');
  const el = ui.el;

  // ---------- property helpers shared by the editing panels ----------

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clipById = (seq, id) => seq?.clips.find((c) => c.id === id) || null;
  const trackOf = (seq, id) => seq?.tracks.find((t) => t.id === id) || null;
  const kindOf = (seq, clip) => trackOf(seq, clip.track)?.kind || 'video';
  const effectDef = (type) => {
    try { return Cut.effects?.get?.(type) || null; } catch { return null; }
  };
  const paramDef = (type, id) => effectDef(type)?.params?.find((p) => p.id === id) || null;
  const KEYFRAME_ONLY = ['opacity', 'reveal'];
  const PROP_DEFAULTS = { position: [0, 0], scale: [100, 100], rotation: 0, anchor: [0, 0], opacity: 100, crop: [0, 0, 0, 0], volume: 0, pan: 0 };

  const edit = {
    clipById,
    trackOf,
    kindOf,
    effectDef,
    paramDef,
    // The selected clip the panels edit: the first selected video clip, else the first selected one.
    primaryClip(app) {
      const seq = app.sequence;
      if (!seq || !app.selection.size) return null;
      const clips = [...app.selection].map((id) => clipById(seq, id)).filter(Boolean);
      return clips.find((c) => kindOf(seq, c) === 'video') || clips[0] || null;
    },
    // Clip time (ticks from the clip's start) of the playhead, kept inside the clip and on a frame.
    clipTime(app, clip, t = app.t) {
      const seq = app.sequence;
      const d = model.clipDuration(clip);
      const f = time.frameTicks(seq.fps);
      const rel = Math.max(0, Math.min(d - f, t - clip.start));
      return Math.round(rel / f) * f;
    },
    inClip: (app, clip, t = app.t) => t >= clip.start && t < model.clipEnd(clip),
    defaultOf(clip, path) {
      const parts = path.split('.');
      if (parts.length === 1) return PROP_DEFAULTS[path];
      if (parts[0] === 'effects') {
        const e = clip.effects.find((x) => x.id === parts[1]);
        const p = e && paramDef(e.type, parts[2]);
        if (p) return p.default;
        try { return e ? Cut.effects?.defaults?.(e.type)?.[parts[2]] : undefined; } catch { return undefined; }
      }
      if (parts[0] === 'layers') return { opacity: 100, reveal: 1 }[parts[2]] ?? model.createTextLayer()[parts[2]];
      return undefined;
    },
    valueAt(app, clip, path, t = app.t) {
      return K.propValue(clip, path, edit.clipTime(app, clip, t), edit.defaultOf(clip, path));
    },
    keyframed: (clip, path) => !!clip.keyframes?.[path]?.length,
    // Writes the static value of a property path: props, effects.<id>.<param> (left out when it is the default), or
    // layers.<id>.<field>.
    setStatic(app, clip, path, value) {
      const seq = app.sequence;
      const parts = path.split('.');
      if (parts.length === 1) return ui.exec(app, C.setClip(seq.id, clip.id, { props: { [path]: value } }));
      if (parts[0] === 'effects') {
        const def = edit.defaultOf(clip, path);
        return ui.exec(app, C.setEffect(seq.id, clip.id, parts[1], { params: { [parts[2]]: def !== undefined && same(def, value) ? null : value } }));
      }
      // opacity and reveal of a text layer exist only as keyframes (textrender.js): a value is a keyframe at the playhead
      if (parts[0] === 'layers' && KEYFRAME_ONLY.includes(parts[2])) return ui.exec(app, C.setKeyframes(seq.id, clip.id, path, [{ t: edit.clipTime(app, clip), v: value, ease: 'linear' }]));
      if (parts[0] === 'layers') return ui.exec(app, C.setLayer(seq.id, clip.id, parts[1], { [parts[2]]: value }));
      return null;
    },
    // A value set at the playhead: with keyframes on, the keyframe at the playhead (made when missing); else the
    // static value.
    write(app, clip, path, value, { t = app.t } = {}) {
      const list = clip.keyframes?.[path];
      if (!list?.length) return edit.setStatic(app, clip, path, value);
      const kt = edit.clipTime(app, clip, t);
      const old = list.find((k) => k.t === kt);
      const before = K.prev(list, kt);
      const next = K.insert(list, { t: kt, v: value, ease: old?.ease || before?.ease || 'linear', h: old?.h });
      return ui.exec(app, C.setKeyframes(app.sequence.id, clip.id, path, next));
    },
    // The stopwatch: on makes a keyframe at the playhead with the value there; off drops the keyframes and keeps the
    // value at the playhead as the static value.
    setKeyframing(app, clip, path, on) {
      const seq = app.sequence;
      const v = edit.valueAt(app, clip, path);
      if (on) return ui.exec(app, C.setKeyframes(seq.id, clip.id, path, [{ t: edit.clipTime(app, clip), v, ease: 'linear' }]));
      app.history.begin('Keyframes');
      try {
        ui.exec(app, C.setKeyframes(seq.id, clip.id, path, null));
        edit.setStatic(app, clipById(app.sequence, clip.id), path, v);
      } finally { app.history.commit(); }
      return {};
    },
    toggleKeyframe(app, clip, path) {
      const list = clip.keyframes?.[path] || [];
      const kt = edit.clipTime(app, clip);
      const next = list.some((k) => k.t === kt) ? K.remove(list, kt) : K.insert(list, { t: kt, v: edit.valueAt(app, clip, path), ease: K.prev(list, kt)?.ease || 'linear' });
      return ui.exec(app, C.setKeyframes(app.sequence.id, clip.id, path, next.length ? next : null));
    },
    // Moves the playhead to the previous or next keyframe of one path, or of several.
    jumpKeyframe(app, clip, paths, dir) {
      const kt = edit.clipTime(app, clip);
      let best = null;
      for (const p of [].concat(paths)) {
        const k = dir < 0 ? K.prev(clip.keyframes?.[p], kt) : K.next(clip.keyframes?.[p], kt);
        if (k && (best === null || (dir < 0 ? k.t > best : k.t < best))) best = k.t;
      }
      if (best !== null) app.setTime(clip.start + best);
      return best;
    },
    // A text clip at `at` (the playhead): on the lowest video track above every clip under its span, or a new track
    // at the top. -> its id. Throws like a command; callers group it with what follows.
    addText(app, { at = app.t, text = '', position = [0, 0], track = null } = {}) {
      const seq = app.sequence;
      const d = app.project.settings.stillDuration;
      const f = time.frameTicks(seq.fps);
      const a = time.snap(Math.max(0, at), seq.fps);
      const vids = seq.tracks.filter((t) => t.kind === 'video');
      const busy = (id) => seq.clips.some((c) => c.track === id && c.start < a + d && model.clipEnd(c) > a);
      let target = track;
      if (!target) {
        let top = -1;
        vids.forEach((t, i) => { if (busy(t.id)) top = i; });
        target = vids.slice(top + 1).find((t) => !t.locked)?.id || null;
        if (!target) target = app.history.do(C.addTrack(seq.id, 'video')).id;
      }
      const r = app.history.do(C.addGenerated(seq.id, { track: target, at: a, duration: Math.max(f, d), name: tr('Text'), source: { generator: 'text', layers: [{ text, position }] } }));
      return r.id;
    },
    // The interpolations a keyframe's menu offers, in its order.
    EASES: [['linear', 'Linear'], ['easeIn', 'Ease In'], ['easeOut', 'Ease Out'], ['easeInOut', 'Ease In and Out'], ['bezier', 'Bezier'], ['hold', 'Hold']],
    // A keyframe list with the keyframes at `times` set to `ease`. One turned into a bezier keyframe gets the handles
    // that draw its segment as it was (Cut.keyframes.handles), so its motion does not jump.
    easeList(list, times, ease) {
      const set = new Set(times);
      return list.map((k) => {
        if (!set.has(k.t)) return k;
        const next = { t: k.t, v: k.v, ease };
        if (ease === 'bezier') next.h = K.handles(k) || K.DEFAULT_HANDLES.slice();
        return next;
      });
    },
    // A drag of a slider or a field: begin() on press, change(v) while it moves, end() on release: one undo step.
    gesture(app, label) {
      let open = false;
      return {
        begin() { if (!open) { app.history.begin(label); open = true; } },
        end() { if (open) { open = false; app.history.commit(); } },
        get open() { return open; },
      };
    },
  };
  ui.edit = edit;

  // Track targeting (which tracks Ctrl+K, Q/W, paste and Ctrl+D act on) next to the source patch of ui-base: null
  // means every track. Emits 'targets' {ids}.
  ui.editing.targets = ui.editing.targets ?? null;
  ui.setTargets = (app, ids) => {
    ui.editing.targets = ids ? [...ids] : null;
    app?.emit('targets', { ids: ui.editing.targets });
  };
  const targeted = (seq) => {
    const ids = ui.editing.targets;
    return seq.tracks.filter((t) => !t.locked && (!ids || ids.includes(t.id))).map((t) => t.id);
  };

  // ---------- look ----------

  const QUICK_SPEEDS = [25, 50, 75, 100, 150, 200, 400];
  const LABELS = {
    violet: '#8a6bd6', iris: '#6c7fe0', caribbean: '#22a08c', lavender: '#b98ad8',
    cerulean: '#2f8ad0', forest: '#4f8c3a', rose: '#cf5a7a', mango: '#d9962e',
  };
  const LABEL_NAMES = { violet: 'Violet', iris: 'Iris', caribbean: 'Caribbean', lavender: 'Lavender', cerulean: 'Cerulean', forest: 'Forest', rose: 'Rose', mango: 'Mango' };
  const MARKER_COLORS = { green: '#5fb236', red: '#e05555', purple: '#a26be0', orange: '#e8913b', yellow: '#e6c84a', white: '#e8e8e8', blue: '#4a8fe6', cyan: '#3fc1c9' };
  const MARKER_NAMES = { green: 'Green', red: 'Red', purple: 'Purple', orange: 'Orange', yellow: 'Yellow', white: 'White', blue: 'Blue', cyan: 'Cyan' };
  let colors = null;
  // fillText's maxWidth squeezes the glyphs; a label that does not fit is cut and ends in an ellipsis instead.
  const fitText = (ctx, text, x, y, maxW) => {
    if (maxW <= 0) return;
    if (ctx.measureText(text).width <= maxW) { ctx.fillText(text, x, y); return; }
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    if (lo) ctx.fillText(text.slice(0, lo) + '…', x, y);
  };
  // Generated clips are named in the UI language when they are made; the model's defaults are English.
  const generatedName = (source) => tr({ text: 'Text', solid: 'Color' }[source?.generator] || 'Text');
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    colors = {
      bg: v('--gray1', '#1e1f22'), row: v('--gray2', '#2b2d30'), rowAlt: v('--gray1', '#1e1f22'), line: v('--gray3', '#393b40'),
      text: v('--gray11', '#ced0d6'), dim: v('--gray8', '#868a91'), faint: v('--gray5', '#4e5157'),
      video: v('--cut-clip-video', '#2f4a78'), audio: v('--cut-clip-audio', '#2c6152'), textClip: v('--cut-clip-text', '#7a4bb0'),
      solid: v('--cut-clip-solid', '#6b5a2a'), selected: v('--cut-selected', '#f2c55c'), playhead: v('--cut-playhead', '#e05555'),
      accent: v('--cut-accent', '#e8743b'), offline: '#a03030', inout: 'rgba(84, 138, 247, 0.16)', guide: '#4fc3f7',
      light: document.documentElement.dataset.theme === 'light',
    };
  };

  const svg = (body) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const ICONS = {
    select: svg('<path d="M4 2v11l3-3 2 4.5 1.6-.7-2-4.4H13z" fill="currentColor"/>'),
    trackForward: svg('<path d="M3 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M6 5.5h5.5M9.5 3.5l2.5 2-2.5 2M6 10.5h5.5M9.5 8.5l2.5 2-2.5 2" stroke="currentColor" stroke-width="1.2"/>'),
    trackBackward: svg('<path d="M13 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M10 5.5H4.5M6.5 3.5 4 5.5l2.5 2M10 10.5H4.5M6.5 8.5 4 10.5l2.5 2" stroke="currentColor" stroke-width="1.2"/>'),
    ripple: svg('<path d="M9 2.5H6.5v11H9" stroke="currentColor" stroke-width="1.4"/><path d="M2 8h3M3.5 6.5 2 8l1.5 1.5M11 8h3.5M13 6.5 14.5 8 13 9.5" stroke="currentColor" stroke-width="1.2"/>'),
    roll: svg('<path d="M5.5 2.5h2.5v11H5.5M10.5 2.5H8v11h2.5" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h2.5M2.8 6.6 1.5 8l1.3 1.4M12 8h2.5M13.2 6.6 14.5 8l-1.3 1.4" stroke="currentColor" stroke-width="1.1"/>'),
    rate: svg('<path d="M13.5 2.5v11" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 8h1.6l1.2-2.6 1.6 5.2 1.6-5.2 1.6 5.2 1.2-2.6h1.2" stroke="currentColor" stroke-width="1.1"/>'),
    razor: svg('<path d="M3 13 13 3" stroke="currentColor" stroke-width="1.4"/><path d="M9.5 3.5h3v3" stroke="currentColor" stroke-width="1.2"/><circle cx="4.5" cy="11.5" r="1.8" stroke="currentColor"/>'),
    slip: svg('<rect x="2" y="4" width="12" height="8" rx=".8" stroke="currentColor" stroke-width="1.2"/><path d="M5 8h6M6.4 6.6 5 8l1.4 1.4M9.6 6.6 11 8l-1.4 1.4" stroke="currentColor" stroke-width="1.1"/>'),
    slide: svg('<rect x="5.5" y="4" width="5" height="8" rx=".8" stroke="currentColor" stroke-width="1.2"/><path d="M1.2 8h2.8M2.5 6.6 1.2 8l1.3 1.4M12 8h2.8M13.5 6.6 14.8 8l-1.3 1.4" stroke="currentColor" stroke-width="1.1"/>'),
    pen: svg('<path d="M3 13.2 4 9.4 10.6 2.8l2.6 2.6L6.6 12z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M3 13.2l2.6-2.6" stroke="currentColor" stroke-width="1.1"/><circle cx="7.3" cy="8.7" r=".9" fill="currentColor"/>'),
    hand: svg('<path d="M5 8V3.8a1 1 0 0 1 2 0V7.5M7 7V2.8a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V8M11 8V5.5a1 1 0 0 1 2 0v4C13 12 11.5 14 9 14H8c-1.6 0-2.5-.7-3.4-2L3 9.3a1 1 0 0 1 1.7-1L5 8.8" stroke="currentColor" stroke-width="1.1"/>'),
    zoom: svg('<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="m10.3 10.3 3.7 3.7M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.3"/>'),
    text: svg('<path d="M3 3.5h10M8 3.5V13M6 13h4" stroke="currentColor" stroke-width="1.5"/>'),
    snap: svg('<path d="M4 2.5v5a4 4 0 0 0 8 0v-5" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 2.5h3M10.5 2.5h3" stroke="currentColor" stroke-width="2.4"/>'),
    linked: svg('<path d="M6.5 9.5 9.5 6.5M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8" stroke="currentColor" stroke-width="1.3"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor"/>'),
    unlock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" opacity=".55"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" stroke="currentColor" opacity=".55"/>'),
    eye: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor"/><circle cx="8" cy="8" r="2" fill="currentColor"/>'),
    eyeOff: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" opacity=".45"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3"/>'),
    sync: svg('<path d="M3 6.5h8.5M9.5 4.5l2 2-2 2M13 9.5H4.5M6.5 7.5l-2 2 2 2" stroke="currentColor" stroke-width="1.2"/>'),
    zoomIn: svg('<path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.5"/>'),
    zoomOut: svg('<path d="M3 8h10" stroke="currentColor" stroke-width="1.5"/>'),
    fit: svg('<path d="M2 5V2.5h3M11 2.5h3V5M14 11v2.5h-3M5 13.5H2V11" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 8h7" stroke="currentColor" stroke-width="1.3"/>'),
    close: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.3"/>'),
  };
  const icon = (name) => {
    const span = el('span', 'ide-icon cut-icon');
    span.dataset.iconName = name;
    span.innerHTML = ICONS[name];
    return span;
  };
  const TOOLS = [
    { id: 'select', title: 'Selection Tool', key: 'V' },
    { id: 'trackForward', title: 'Track Select Forward Tool', key: 'A' },
    { id: 'trackBackward', title: 'Track Select Backward Tool', key: 'Shift+A' },
    { id: 'ripple', title: 'Ripple Edit Tool', key: 'B' },
    { id: 'roll', title: 'Rolling Edit Tool', key: 'N' },
    { id: 'rate', title: 'Rate Stretch Tool', key: 'R' },
    { id: 'razor', title: 'Razor Tool', key: 'C' },
    { id: 'slip', title: 'Slip Tool', key: 'Y' },
    { id: 'slide', title: 'Slide Tool', key: 'U' },
    { id: 'pen', title: 'Pen Tool', key: 'P' },
    { id: 'hand', title: 'Hand Tool', key: 'H' },
    { id: 'zoom', title: 'Zoom Tool', key: 'Z' },
    { id: 'text', title: 'Type Tool', key: 'T' },
  ];
  const CURSORS = { razor: 'crosshair', hand: 'grab', zoom: 'zoom-in', text: 'text', pen: 'cell' };
  // The tools and their glyphs for the Tools panel (ui-toolspanel.js).
  ui.timelineTools = { list: TOOLS, icon };
  // The tool buttons in the timeline's own bar: off by default (the Tools panel has them, as in Premiere), on with
  // the setting `cut.timelineTools` (Window > Timeline Tool Bar).
  const BAR_TOOLS_KEY = 'cut.timelineTools';
  // Track heights the keys change (Ctrl/Alt+= and -) and Expand/Minimize All Tracks set.
  const TRACK_H = { min: 24, max: 240, step: 16, expanded: 100 };

  const RULER_H = 30;
  const CAPTION_H = 28;
  const DIVIDER = 6;
  const EDGE = 7;
  const SNAP_PX = 8;
  const MAX_CONTENT_PX = 30e6;

  // ---------- the panel ----------

  let current = null; // the mounted timeline (one at a time)

  function mount(host, app) {
    readColors();
    const offs = [];
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); };
    const v = {
      pps: 60, scrollX: 0, scrollY: 0, linked: true,
      hover: null, drag: null, guide: null, gap: null, transition: null, caption: null, drop: null, razorAt: null,
      overlay: null, // {ranges: [[a, b]], tracks: [ids] | null}: time ranges an automation previews (ui-auto.js)
      tabs: [], perSeq: new Map(),
    };
    const stats = { base: [], top: [], frames: 0, thumbs: 0, waves: 0 };

    // DOM
    const root = el('div', 'cut-tl', undefined, { tabindex: -1 });
    const bar = el('div', 'cut-tl-bar');
    const tabs = el('div', 'cut-tl-tabs');
    const tools = el('div', 'cut-tl-tools');
    const toolButtons = new Map();
    for (const tl of TOOLS) {
      const b = el('button', 'cut-tl-tool', undefined, { type: 'button', 'data-tool': tl.id });
      b.appendChild(icon(tl.id));
      ide.keymap.tooltip(b, tr(tl.title), `Cut.tool.${tl.id}`);
      b.setAttribute('aria-label', tr(tl.title));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => app.setTool(tl.id));
      toolButtons.set(tl.id, b);
      tools.appendChild(b);
    }
    const snapBtn = el('button', 'cut-tl-toggle', undefined, { type: 'button', 'data-role': 'snap' });
    snapBtn.appendChild(icon('snap'));
    ide.keymap.tooltip(snapBtn, tr('Snap in Timeline'), 'Cut.snap');
    snapBtn.addEventListener('mousedown', (e) => e.preventDefault());
    snapBtn.addEventListener('click', () => ui.setSnapping(app, !ui.editing.snapping));
    const linkBtn = el('button', 'cut-tl-toggle', undefined, { type: 'button', 'data-role': 'linked' });
    linkBtn.appendChild(icon('linked'));
    linkBtn.title = tr('Linked Selection');
    linkBtn.addEventListener('mousedown', (e) => e.preventDefault());
    linkBtn.addEventListener('click', () => { v.linked = !v.linked; syncBar(); });
    const zoomBox = el('div', 'cut-tl-zoom');
    const zoomOutBtn = ide.keymap.tooltip(el('button', 'cut-tl-toggle', undefined, { type: 'button' }), tr('Zoom Out'), 'Cut.zoomOut');
    zoomOutBtn.appendChild(icon('zoomOut'));
    const zoomRange = el('input', 'cut-tl-zoomrange', undefined, { type: 'range', min: 0, max: 1000, step: 1, title: tr('Zoom') });
    const zoomInBtn = ide.keymap.tooltip(el('button', 'cut-tl-toggle', undefined, { type: 'button' }), tr('Zoom In'), 'Cut.zoomIn');
    zoomInBtn.appendChild(icon('zoomIn'));
    const fitBtn = ide.keymap.tooltip(el('button', 'cut-tl-toggle', undefined, { type: 'button' }), tr('Zoom to Sequence'), 'Cut.zoomFit');
    fitBtn.appendChild(icon('fit'));
    for (const b of [zoomOutBtn, zoomInBtn, fitBtn]) b.addEventListener('mousedown', (e) => e.preventDefault());
    zoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.6));
    zoomInBtn.addEventListener('click', () => zoomBy(1.6));
    fitBtn.addEventListener('click', () => zoomFit());
    zoomRange.addEventListener('input', () => setZoom(rangeToPps(Number(zoomRange.value)), anchorForZoom()));
    zoomBox.append(zoomOutBtn, zoomRange, zoomInBtn, fitBtn);
    bar.append(tabs, tools, snapBtn, linkBtn, zoomBox);

    const main = el('div', 'cut-tl-main');
    const corner = el('div', 'cut-tl-corner');
    const tc = ui.timecodeField({ fps: () => app.sequence?.fps || [30, 1], value: app.t, onChange: (t) => app.setTime(t), title: tr('Playhead Position') });
    corner.appendChild(tc);
    const rulerBox = el('div', 'cut-tl-ruler');
    const rulerCanvas = el('canvas');
    rulerBox.appendChild(rulerCanvas);
    const heads = el('div', 'cut-tl-heads');
    const headsInner = el('div', 'cut-tl-heads-inner');
    heads.appendChild(headsInner);
    const lanes = el('div', 'cut-tl-lanes');
    const baseCanvas = el('canvas', 'cut-tl-base');
    const topCanvas = el('canvas', 'cut-tl-top');
    const scroller = el('div', 'cut-tl-scroll');
    const sizer = el('div', 'cut-tl-sizer');
    const tip = el('div', 'cut-tl-tip');
    scroller.appendChild(sizer);
    lanes.append(baseCanvas, topCanvas, scroller, tip);
    main.append(corner, rulerBox, heads, lanes);
    root.append(bar, main);
    host.appendChild(root);

    // ---------- model views ----------
    let seq = null;
    let rows = [];
    let contentH = 0;
    let byTrack = new Map();
    let rowOfTrack = new Map();
    let snapPts = [];
    let media = new Map();
    function rebuild() {
      seq = app.sequence;
      rows = [];
      byTrack = new Map();
      rowOfTrack = new Map();
      media = new Map((app.project?.media || []).map((m) => [m.id, m]));
      let y = 0;
      if (seq) {
        for (const ct of seq.captions) { rows.push({ type: 'caption', id: ct.id, ct, y, h: CAPTION_H }); y += CAPTION_H; }
        const vids = seq.tracks.filter((t) => t.kind === 'video');
        for (let i = vids.length - 1; i >= 0; i--) { rows.push({ type: 'video', id: vids[i].id, track: vids[i], index: i, y, h: vids[i].height }); y += vids[i].height; }
        rows.push({ type: 'divider', id: '-', y, h: DIVIDER });
        y += DIVIDER;
        seq.tracks.filter((t) => t.kind === 'audio').forEach((t, i) => { rows.push({ type: 'audio', id: t.id, track: t, index: i, y, h: t.height }); y += t.height; });
        for (const t of seq.tracks) byTrack.set(t.id, []);
        for (const c of seq.clips) byTrack.get(c.track)?.push(c);
        for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start);
        for (const r of rows) if (r.track) rowOfTrack.set(r.id, r);
      }
      contentH = y + 40;
      snapPts = null;
      layoutSizer();
      buildHeads();
      invalidate();
    }
    const fps = () => seq?.fps || [30, 1];
    const frame = () => time.frameTicks(fps());
    const snapT = (t) => time.snap(Math.max(0, t), fps(), { nearest: true });
    const xOf = (t) => (t / T) * v.pps - v.scrollX;
    const tOf = (x) => ((x + v.scrollX) / v.pps) * T;
    const pxOf = (d) => (d / T) * v.pps;
    const viewW = () => scroller.clientWidth;
    const viewH = () => scroller.clientHeight;
    const seqEnd = () => (seq ? model.sequenceDuration(seq) : 0);
    const rowsOfKind = (kind) => rows.filter((r) => r.type === kind);
    const rowAtY = (y) => {
      const yy = y + v.scrollY;
      return rows.find((r) => yy >= r.y && yy < r.y + r.h) || null;
    };

    // ---------- zoom and scroll ----------
    const minPps = () => {
      const d = Math.max(seqEnd(), 60 * T);
      return Math.max(1e-3, Math.min(5, (viewW() * 0.25) / (d / T)));
    };
    const maxPps = () => {
      const perFrame = 80 * time.fpsValue(fps());
      const longest = Math.max(seqEnd(), 60 * T) / T;
      return Math.max(minPps() * 2, Math.min(perFrame, MAX_CONTENT_PX / (longest * 1.5)));
    };
    const ppsToRange = (p) => (1000 * Math.log(p / minPps())) / Math.log(maxPps() / minPps());
    const rangeToPps = (r) => minPps() * Math.exp((r / 1000) * Math.log(maxPps() / minPps()));
    function contentW() {
      const d = Math.max(seqEnd() + (viewW() / v.pps) * T * 0.5, (viewW() / v.pps) * T);
      return Math.min(MAX_CONTENT_PX, (d / T) * v.pps);
    }
    function layoutSizer() {
      sizer.style.width = `${Math.ceil(contentW())}px`;
      sizer.style.height = `${Math.ceil(contentH)}px`;
    }
    function setScroll(x, y = v.scrollY) {
      const maxX = Math.max(0, contentW() - viewW());
      v.scrollX = Math.max(0, Math.min(maxX, x));
      v.scrollY = Math.max(0, Math.min(Math.max(0, contentH - viewH()), y));
      if (Math.abs(scroller.scrollLeft - v.scrollX) > 0.5) scroller.scrollLeft = v.scrollX;
      if (Math.abs(scroller.scrollTop - v.scrollY) > 0.5) scroller.scrollTop = v.scrollY;
      headsInner.style.transform = `translateY(${-v.scrollY}px)`;
      invalidate();
    }
    // The point that stays put when zooming: the playhead when it is in view, else the middle.
    function anchorForZoom() {
      const x = xOf(app.t);
      if (x >= 0 && x <= viewW()) return { t: app.t, x };
      return { t: tOf(viewW() / 2), x: viewW() / 2 };
    }
    function setZoom(pps, anchor = anchorForZoom()) {
      v.pps = Math.max(minPps(), Math.min(maxPps(), pps));
      layoutSizer();
      setScroll((anchor.t / T) * v.pps - anchor.x);
      zoomRange.value = String(Math.round(ppsToRange(v.pps)));
      invalidate();
    }
    const zoomBy = (k, anchor) => setZoom(v.pps * k, anchor);
    function zoomFit() {
      const d = Math.max(seqEnd(), 10 * T);
      v.pps = Math.max(minPps(), Math.min(maxPps(), (viewW() * 0.96) / (d / T)));
      layoutSizer();
      setScroll(0);
      zoomRange.value = String(Math.round(ppsToRange(v.pps)));
    }
    on(scroller, 'scroll', () => {
      v.scrollX = scroller.scrollLeft;
      v.scrollY = scroller.scrollTop;
      headsInner.style.transform = `translateY(${-v.scrollY}px)`;
      invalidate();
    });
    on(scroller, 'wheel', (e) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      const x = e.clientX - r.left;
      zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, { t: tOf(x), x });
    }, { passive: false });
    on(rulerBox, 'wheel', (e) => {
      e.preventDefault();
      const r = rulerBox.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (e.altKey || e.ctrlKey) zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, { t: tOf(x), x });
      else setScroll(v.scrollX + (e.deltaX || e.deltaY));
    }, { passive: false });

    // ---------- canvases ----------
    let dirtyBase = true;
    let dirtyTop = true;
    let dirtyRuler = true;
    let raf = 0;
    function invalidate(baseToo = true) {
      if (baseToo) { dirtyBase = true; dirtyRuler = true; }
      dirtyTop = true;
      if (!raf) raf = requestAnimationFrame(paint);
    }
    const invalidateTop = () => invalidate(false);
    function fit(canvas, w, h) {
      const dpr = devicePixelRatio || 1;
      const W = Math.max(1, Math.round(w * dpr));
      const H = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    }
    function paint() {
      raf = 0;
      if (!root.isConnected) return;
      stats.frames++;
      const w = viewW();
      const h = viewH();
      if (dirtyBase) {
        dirtyBase = false;
        const a = performance.now();
        drawBase(fit(baseCanvas, w, h), w, h);
        trimThumbs();
        pushStat(stats.base, performance.now() - a);
      }
      if (dirtyRuler) {
        dirtyRuler = false;
        drawRuler(fit(rulerCanvas, rulerBox.clientWidth, RULER_H), rulerBox.clientWidth);
      }
      if (dirtyTop) {
        dirtyTop = false;
        const a = performance.now();
        drawTop(fit(topCanvas, w, h), w, h);
        pushStat(stats.top, performance.now() - a);
      }
    }
    const pushStat = (list, ms) => { list.push(ms); if (list.length > 240) list.shift(); };
    const resizeObs = ide.util.observeSize(lanes, () => { layoutSizer(); setScroll(v.scrollX, v.scrollY); invalidate(); });
    offs.push(() => resizeObs.disconnect());
    offs.push(() => cancelAnimationFrame(raf));

    // ---------- the ruler ----------
    const STEPS = [1, 2, 5, 10, 15].map((n) => ({ frames: n })).concat([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => ({ secs: s })));
    function rulerStep() {
      const f = frame();
      for (const s of STEPS) {
        const ticks = s.frames ? s.frames * f : s.secs * T;
        if (pxOf(ticks) >= 90) return ticks;
      }
      return 7200 * T;
    }
    function drawRuler(ctx, w) {
      ctx.fillStyle = colors.row;
      ctx.fillRect(0, 0, w, RULER_H);
      if (!seq) return;
      // In/Out
      const { in: a, out: b } = app.inOut;
      if (a != null || b != null) {
        const x1 = a != null ? xOf(a) : 0;
        const x2 = b != null ? xOf(b) : w;
        ctx.fillStyle = 'rgba(84, 138, 247, 0.35)';
        ctx.fillRect(x1, RULER_H - 8, x2 - x1, 8);
        ctx.fillStyle = colors.guide;
        if (a != null) ctx.fillRect(x1, RULER_H - 12, 2, 12);
        if (b != null) ctx.fillRect(x2 - 2, RULER_H - 12, 2, 12);
      }
      const step = rulerStep();
      const minor = step / 5;
      const t0 = Math.max(0, Math.floor(tOf(0) / minor) * minor);
      ctx.strokeStyle = colors.dim;
      ctx.fillStyle = colors.text;
      ctx.font = '10px var(--mono), Consolas, monospace';
      ctx.textBaseline = 'top';
      ctx.beginPath();
      for (let t = t0, i = 0; xOf(t) <= w && i < 2000; t += minor, i++) {
        const x = Math.round(xOf(t)) + 0.5;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, RULER_H - (major ? 12 : 5));
        if (major) ctx.fillText(time.timecode(snapT(t), fps()), x + 3, 3);
      }
      ctx.stroke();
      // markers (beat markers are a thin tick: there are hundreds of them)
      // A marker being dragged is drawn where it would land.
      const md = v.markerDrag;
      for (const m of seq.markers) {
        const mt = md?.id === m.id ? md.t : m.t;
        const mdur = md?.id === m.id ? md.duration : m.duration;
        const x = xOf(mt);
        if ((x < -20 && x + pxOf(mdur) < -20) || x > w + 20) continue;
        ctx.fillStyle = MARKER_COLORS[m.color] || MARKER_COLORS.green;
        if (m.kind === 'beat') {
          ctx.fillRect(Math.round(x) - (m.name ? 1 : 0.5), m.name ? 12 : 16, m.name ? 2 : 1, m.name ? 12 : 8);
          continue;
        }
        if (mdur > 0) {
          // a range marker: the band and a handle at its end
          ctx.globalAlpha = 0.45;
          ctx.fillRect(x, 14, pxOf(mdur), 6);
          ctx.globalAlpha = 1;
          ctx.fillRect(Math.round(x + pxOf(mdur)) - 1, 12, 2, 10);
        }
        ctx.beginPath();
        ctx.moveTo(x - 5, 13);
        ctx.lineTo(x + 5, 13);
        ctx.lineTo(x + 5, 19);
        ctx.lineTo(x, 23);
        ctx.lineTo(x - 5, 19);
        ctx.closePath();
        ctx.fill();
        if (m.kind === 'chapter') {
          ctx.fillStyle = '#000';
          ctx.fillRect(x - 2, 15, 4, 2);
        }
      }
      // the playhead
      const px = xOf(app.t);
      ctx.fillStyle = colors.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER_H - 12);
      ctx.lineTo(px + 6, RULER_H - 12);
      ctx.lineTo(px + 6, RULER_H - 6);
      ctx.lineTo(px, RULER_H);
      ctx.lineTo(px - 6, RULER_H - 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(Math.round(px) - 0.5, 0, 1, RULER_H);
    }

    // ---------- thumbnails and waveforms ----------
    const thumbCache = new Map(); // key -> {bitmaps | null, gen}, least recently used first
    const thumbReady = new Map(); // a clip's media and range -> the key of a strip of it already loaded
    const thumbQueue = [];
    let thumbBusy = 0;
    let thumbGen = 0; // the base paint an entry was last used in
    const THUMB_KEEP = 500;
    const THUMB_MIN_W = 8; // px: a narrower clip shows no picture, so it asks for none
    const peaksCache = new Map(); // mediaId -> {peaks, rate} | 'pending' | 'failed'
    // By the file, not the media id: the timeline outlives a project, and another project's m1 is another file.
    const rangeKey = (m, c) => `${m.path}|${m.size}|${m.mtime}|${c.reverse ? 1 : 0}|${Math.round(c.in)}|${Math.round(c.out)}|`;
    function thumbKey(m, c, count, h) { return `${rangeKey(m, c)}${count}|${h}`; }
    function thumbsFor(c, m, w, h) {
      if (!Cut.thumbs?.strip || !m || (m.kind !== 'video' && m.kind !== 'image') || w < THUMB_MIN_W) return null;
      const aspect = m.video?.w && m.video?.h ? m.video.w / m.video.h : 16 / 9;
      const still = m.kind === 'image' || c.source?.freeze;
      const tw = Math.max(12, h * aspect);
      const count = still ? 1 : Math.min(64, 2 ** Math.ceil(Math.log2(Math.max(1, w / tw))));
      const hb = h <= 40 ? 40 : h <= 72 ? 72 : 120;
      const key = thumbKey(m, c, count, hb);
      const prefix = rangeKey(m, c);
      const hitC = thumbCache.get(key);
      if (hitC) {
        thumbCache.delete(key);
        thumbCache.set(key, hitC);
        hitC.gen = thumbGen;
        if (hitC.bitmaps) return { bitmaps: hitC.bitmaps, tw, still };
      } else {
        thumbCache.set(key, { bitmaps: null, gen: thumbGen });
        thumbQueue.push({ key, prefix, m, history: app.history, from: still ? c.in : Math.min(c.in, c.out), to: still ? c.in : Math.max(c.in, c.out), count, h: hb, reverse: c.reverse });
        pumpThumbs();
      }
      // While the right count loads, a strip of the same range keeps the clip from flashing empty.
      const ready = thumbCache.get(thumbReady.get(prefix));
      return ready?.bitmaps ? { bitmaps: ready.bitmaps, tw, still } : null;
    }
    // After a base paint, never a strip it drew: with more clips on screen than the cache holds, each would push out
    // another, be asked for again on the next frame, and the timeline would redraw and decode without end. (Trimming
    // during the paint dropped clips it had not reached yet: 39,000 requests for 540 clips.)
    function trimThumbs() {
      while (thumbCache.size > THUMB_KEEP) {
        const [k, e] = thumbCache.entries().next().value;
        if (e.gen === thumbGen) break;
        thumbCache.delete(k);
      }
    }
    function pumpThumbs() {
      while (thumbBusy < 2 && thumbQueue.length) {
        // Visible clips first: the newest requests are for what is on screen now.
        const job = thumbQueue.pop();
        // asked in a project since closed: its media ids may name other files now
        if (!thumbCache.has(job.key) || job.history !== app.history) continue;
        thumbBusy++;
        Promise.resolve()
          .then(() => Cut.thumbs.strip(app.project, job.m.id, { from: job.from, to: job.to, count: job.count, height: job.h, wanted: () => app.history === job.history }))
          .then((list) => {
            const e = thumbCache.get(job.key);
            if (e) {
              e.bitmaps = (job.reverse ? [...(list || [])].reverse() : list || []).filter(Boolean);
              thumbReady.set(job.prefix, job.key);
            }
            invalidate();
          })
          .catch((err) => { const e = thumbCache.get(job.key); if (e) e.bitmaps = []; log.warn(`thumbnails of ${job.m.name}: ${err?.message || err}`); })
          .finally(() => { thumbBusy--; pumpThumbs(); });
      }
      // A dropped request leaves the cache too, so its clip asks again when it is drawn (else it stays empty).
      if (thumbQueue.length > 200) for (const job of thumbQueue.splice(0, thumbQueue.length - 200)) if (!thumbCache.get(job.key)?.bitmaps) thumbCache.delete(job.key);
    }
    function peaksFor(m) {
      if (!Cut.thumbs?.peaks || !m?.audio) return null;
      const e = peaksCache.get(m.id);
      if (e && typeof e === 'object') return e;
      if (e) return null;
      peaksCache.set(m.id, 'pending');
      const spp = 256;
      Promise.resolve()
        .then(() => Cut.thumbs.peaks(app.project, m.id, { samplesPerPeak: spp }))
        .then((peaks) => { peaksCache.set(m.id, peaks ? { peaks, perSec: (m.audio.rate || 48000) / spp } : 'failed'); invalidate(); })
        .catch((err) => { peaksCache.set(m.id, 'failed'); log.warn(`waveform of ${m.name}: ${err?.message || err}`); });
      return null;
    }

    // ---------- drawing the lanes ----------
    const clipColor = (c, kind) => {
      if (c.label && LABELS[c.label]) return LABELS[c.label];
      if (c.source?.generator === 'text') return colors.textClip;
      if (c.source?.generator) return colors.solid;
      return kind === 'audio' ? colors.audio : colors.video;
    };
    // Visible clips of a track (sorted, never overlapping: ends are sorted too).
    function visible(list, t0, t1) {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (model.clipEnd(list[mid]) <= t0) lo = mid + 1;
        else hi = mid;
      }
      const out = [];
      for (let i = lo; i < list.length && list[i].start < t1; i++) out.push(list[i]);
      return out;
    }
    const bandProp = (kind) => (kind === 'audio' ? 'volume' : 'opacity');
    const BAND = { volume: { lo: -60, hi: 15 }, opacity: { lo: 0, hi: 100 } };
    function bandY(prop, val, y, h) {
      const r = BAND[prop];
      const top = y + 16;
      const bottom = y + h - 4;
      const k = (Math.max(r.lo, Math.min(r.hi, val)) - r.lo) / (r.hi - r.lo);
      return bottom - k * (bottom - top);
    }
    function bandValue(prop, py, y, h) {
      const r = BAND[prop];
      const top = y + 16;
      const bottom = y + h - 4;
      const k = Math.max(0, Math.min(1, (bottom - py) / (bottom - top)));
      return Math.round((r.lo + k * (r.hi - r.lo)) * 10) / 10;
    }
    const showsBand = (row) => row.h >= 34;
    // Source left beyond each end of a clip, in timeline ticks (Infinity for stills).
    function roomOf(c) {
      if (model.isStill(app.project, c)) return { head: Infinity, tail: Infinity };
      const m = media.get(c.source?.media);
      if (!m) return { head: 0, tail: 0 };
      const head = c.reverse ? m.duration - c.out : c.in;
      const tail = c.reverse ? c.in : m.duration - c.out;
      return { head: Math.max(0, head / c.speed), tail: Math.max(0, tail / c.speed) };
    }
    function transitionSpan(tr0) {
      const d = tr0.duration;
      if (tr0.align === 'start') return [tr0.at, tr0.at + d];
      if (tr0.align === 'end') return [tr0.at - d, tr0.at];
      return [tr0.at - d / 2, tr0.at + d / 2];
    }
    // Whether the clips around a transition have the source frames it needs ("the frames run out": stripes).
    function transitionShort(tr0) {
      const list = byTrack.get(tr0.track) || [];
      const out = list.find((c) => model.clipEnd(c) === tr0.at);
      const inc = list.find((c) => c.start === tr0.at);
      const [a, b] = transitionSpan(tr0);
      if (out && b > tr0.at && roomOf(out).tail < b - tr0.at) return true;
      if (inc && a < tr0.at && roomOf(inc).head < tr0.at - a) return true;
      return false;
    }
    function drawBase(ctx, w, h) {
      thumbGen++;
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, h);
      if (!seq) {
        ctx.fillStyle = colors.dim;
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(tr('No sequence is open. Create one in the Project panel.'), 16, 24);
        return;
      }
      const t0 = tOf(0);
      const t1 = tOf(w);
      // rows
      for (const r of rows) {
        const y = r.y - v.scrollY;
        if (y > h || y + r.h < 0) continue;
        if (r.type === 'divider') { ctx.fillStyle = colors.line; ctx.fillRect(0, y + 2, w, 2); continue; }
        ctx.fillStyle = r.type === 'caption' ? colors.rowAlt : r.track && (r.index % 2) ? colors.rowAlt : colors.row;
        ctx.globalAlpha = colors.light ? 0.6 : 0.55;
        ctx.fillRect(0, y, w, r.h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors.line;
        ctx.fillRect(0, y + r.h - 1, w, 1);
        if (r.track?.locked) {
          ctx.save();
          ctx.globalAlpha = 0.18;
          ctx.strokeStyle = colors.dim;
          ctx.beginPath();
          for (let x = -(v.scrollX % 12); x < w + r.h; x += 12) { ctx.moveTo(x, y + r.h); ctx.lineTo(x + r.h, y); }
          ctx.stroke();
          ctx.restore();
        }
      }
      // In/Out across the lanes
      const { in: a, out: b } = app.inOut;
      if (a != null && b != null) {
        ctx.fillStyle = colors.inout;
        ctx.fillRect(xOf(a), 0, xOf(b) - xOf(a), h);
      }
      // gap selection
      if (v.gap) {
        const r = rowOfTrack.get(v.gap.track);
        if (r) {
          ctx.fillStyle = 'rgba(242, 197, 92, 0.25)';
          ctx.fillRect(xOf(v.gap.a), r.y - v.scrollY + 1, pxOf(v.gap.b - v.gap.a), r.h - 2);
        }
      }
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      for (const r of rows) {
        const y = r.y - v.scrollY;
        if (y > h || y + r.h < 0) continue;
        if (r.type === 'caption') { drawCaptions(ctx, r, y, t0, t1, w); continue; }
        if (!r.track) continue;
        for (const c of visible(byTrack.get(r.id) || [], t0, t1)) drawClip(ctx, c, r, y, w);
      }
      // transitions
      for (const tr0 of seq.transitions) {
        const r = rowOfTrack.get(tr0.track);
        if (!r) continue;
        const [ta, tb] = transitionSpan(tr0);
        if (tb < t0 || ta > t1) continue;
        const y = r.y - v.scrollY;
        const x1 = xOf(ta);
        const x2 = xOf(tb);
        const hh = Math.min(r.h - 4, 22);
        const ty = y + r.h - hh - 3;
        ctx.save();
        ctx.fillStyle = colors.light ? 'rgba(255,255,255,0.85)' : 'rgba(40,40,46,0.9)';
        ctx.fillRect(x1, ty, Math.max(2, x2 - x1), hh);
        ctx.strokeStyle = v.transition === tr0.id ? colors.selected : colors.text;
        ctx.lineWidth = v.transition === tr0.id ? 2 : 1;
        ctx.strokeRect(x1 + 0.5, ty + 0.5, Math.max(2, x2 - x1) - 1, hh - 1);
        ctx.beginPath();
        ctx.moveTo(x1, ty + hh);
        ctx.lineTo(x2, ty);
        ctx.stroke();
        if (transitionShort(tr0)) {
          ctx.beginPath();
          ctx.rect(x1, ty, x2 - x1, hh);
          ctx.clip();
          ctx.strokeStyle = 'rgba(224, 85, 85, 0.75)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = x1 - hh; x < x2; x += 5) { ctx.moveTo(x, ty + hh); ctx.lineTo(x + hh, ty); }
          ctx.stroke();
        }
        ctx.restore();
        if (x2 - x1 > 40) {
          ctx.fillStyle = colors.text;
          fitText(ctx, transitionName(tr0.type), x1 + 4, ty + 4, x2 - x1 - 8);
        }
      }
    }
    const transitionName = (type) => {
      try { const d = Cut.effects?.transitions?.().find((x) => x.type === type); return d ? tr(d.name) : type; } catch { return type; }
    };
    function drawCaptions(ctx, r, y, t0, t1, w) {
      for (const it of r.ct.items) {
        if (it.end < t0 || it.start > t1) continue;
        const x1 = Math.max(-2, xOf(it.start));
        const x2 = Math.min(w + 2, xOf(it.end));
        ctx.fillStyle = colors.light ? '#d8c58a' : '#5a5030';
        ctx.fillRect(x1, y + 2, Math.max(1, x2 - x1 - 1), r.h - 4);
        const sel = v.caption?.track === r.id && v.caption.id === it.id;
        if (sel) { ctx.strokeStyle = colors.selected; ctx.lineWidth = 2; ctx.strokeRect(x1 + 1, y + 3, x2 - x1 - 3, r.h - 6); }
        if (x2 - x1 > 20) {
          ctx.fillStyle = colors.light ? '#2a2410' : '#f0e6c0';
          fitText(ctx, it.text.replace(/\s+/g, ' '), x1 + 4, y + 8, x2 - x1 - 8);
        }
      }
    }
    function drawClip(ctx, c, r, y, w) {
      const kind = r.type;
      const x1 = xOf(c.start);
      const x2 = xOf(model.clipEnd(c));
      const cy = y + 1;
      const ch = r.h - 3;
      const cw = Math.max(1, x2 - x1);
      const m = c.source?.media != null ? media.get(c.source.media) : null;
      const offline = c.source?.media != null && (!m || !!ui.media?.offline?.has?.(m.id));
      const sel = app.selection.has(c.id);
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(-4, x1), cy, Math.min(w + 8, x2) - Math.max(-4, x1), ch);
      ctx.clip();
      ctx.globalAlpha = c.enabled ? 1 : 0.4;
      ctx.fillStyle = offline ? colors.offline : clipColor(c, kind);
      ctx.fillRect(x1, cy, cw, ch);
      // thumbnails and waveform under the name bar
      const by = cy + 15;
      const bh = ch - 15;
      if (!offline && bh >= 14 && m) {
        if (kind === 'video') {
          const th = thumbsFor(c, m, cw, bh);
          if (th && th.bitmaps.length) {
            // Tiles at the picture's own aspect, each showing the strip frame under its middle; squeezing all n
            // frames into the clip's width drew them narrower than they are.
            const n = th.bitmaps.length;
            const tw = th.tw;
            const first = Math.max(0, Math.floor((0 - x1) / tw));
            const last = Math.ceil((Math.min(w, x2) - x1) / tw);
            for (let k = first; k < last; k++) {
              const bm = th.bitmaps[th.still ? 0 : Math.min(n - 1, Math.floor((((k + 0.5) * tw) / cw) * n))];
              if (!bm) continue;
              try { ctx.drawImage(bm, x1 + k * tw, by, tw, bh); stats.thumbs++; } catch {}
            }
          }
        } else if (kind === 'audio') drawWave(ctx, c, m, x1, x2, by, bh, w);
      }
      // name bar
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x1, cy, cw, 15);
      if (cw > 18) {
        ctx.fillStyle = '#f2f2f2';
        let label = offline ? `${c.name || m?.name || ''} — ${tr('Media Offline')}` : c.name || m?.name || '';
        if (c.speed !== 1) label += ` [${Math.round(c.speed * 1000) / 10}%]`;
        if (c.reverse) label += ` ${tr('(Reversed)')}`;
        const lx = Math.max(x1 + 4, 4);
        const fxW = c.effects.length ? 18 : 0;
        if (fxW && cw > 40) {
          ctx.fillStyle = '#f2c55c';
          ctx.fillText('fx', x1 + 3, cy + 2);
          ctx.fillStyle = '#f2f2f2';
        }
        fitText(ctx, label, lx + (lx === x1 + 4 ? fxW : 0), cy + 2, Math.min(x2, w) - lx - 6 - fxW);
      }
      // the keyframe line (volume of audio, opacity of video)
      if (showsBand(r) && !offline) {
        const prop = bandProp(kind);
        const list = c.keyframes?.[prop];
        // An audio clip's line is the level it plays at: its volume with Auto Ducking's dips added.
        const duck = kind === 'audio' ? c.keyframes?.duck : null;
        ctx.strokeStyle = kind === 'audio' ? '#f2d36b' : '#e8e8e8';
        ctx.globalAlpha = (c.enabled ? 0.85 : 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (list?.length || duck?.length) {
          const step = 3;
          for (let x = Math.max(x1, 0); x <= Math.min(x2, w); x += step) {
            const tau = tOf(x) - c.start;
            const val = (list?.length ? K.valueAt(list, tau, 0) : c.props[prop] ?? 0) + (duck?.length ? K.valueAt(duck, tau, 0) : 0);
            const yy = bandY(prop, val, cy, ch);
            if (x === Math.max(x1, 0)) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
          }
          ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle;
          for (const k of list || []) {
            const kx = xOf(c.start + k.t);
            const ky = bandY(prop, k.v, cy, ch);
            ctx.beginPath();
            ctx.moveTo(kx, ky - 4); ctx.lineTo(kx + 4, ky); ctx.lineTo(kx, ky + 4); ctx.lineTo(kx - 4, ky);
            ctx.closePath();
            ctx.fill();
          }
        } else {
          const yy = Math.round(bandY(prop, c.props[prop] ?? BAND[prop].hi, cy, ch)) + 0.5;
          ctx.moveTo(Math.max(x1, 0), yy);
          ctx.lineTo(Math.min(x2, w), yy);
          ctx.stroke();
        }
        ctx.globalAlpha = c.enabled ? 1 : 0.4;
      }
      // audio fades: the ramps and their handles
      if (kind === 'audio' && r.h >= 30) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        if (c.fadeIn > 0) { ctx.beginPath(); ctx.moveTo(x1, cy + ch); ctx.lineTo(x1, cy + 15); ctx.lineTo(x1 + pxOf(c.fadeIn), cy + 15); ctx.closePath(); ctx.fill(); }
        if (c.fadeOut > 0) { ctx.beginPath(); ctx.moveTo(x2, cy + ch); ctx.lineTo(x2, cy + 15); ctx.lineTo(x2 - pxOf(c.fadeOut), cy + 15); ctx.closePath(); ctx.fill(); }
        if (sel || v.hover?.clip === c) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x1 + pxOf(c.fadeIn) - 3, cy + 15, 6, 6);
          ctx.fillRect(x2 - pxOf(c.fadeOut) - 3, cy + 15, 6, 6);
        }
      }
      // clip markers
      for (const mk of c.markers || []) {
        const mx = xOf(c.start + mk.t);
        ctx.fillStyle = MARKER_COLORS[mk.color] || MARKER_COLORS.green;
        ctx.beginPath(); ctx.moveTo(mx - 4, cy); ctx.lineTo(mx + 4, cy); ctx.lineTo(mx, cy + 6); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // handles: a corner mark where the source has more frames past the clip's end
      if (!offline && cw > 12) {
        const room = roomOf(c);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        if (room.head <= 0) { ctx.beginPath(); ctx.moveTo(x1, cy); ctx.lineTo(x1 + 6, cy); ctx.lineTo(x1, cy + 6); ctx.closePath(); ctx.fill(); }
        if (room.tail <= 0) { ctx.beginPath(); ctx.moveTo(x2, cy); ctx.lineTo(x2 - 6, cy); ctx.lineTo(x2, cy + 6); ctx.closePath(); ctx.fill(); }
      }
      // a grouped clip has a dashed outline
      ctx.strokeStyle = sel ? colors.selected : c.group ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)';
      ctx.lineWidth = sel ? 2 : 1;
      if (c.group) ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1 + (sel ? 1 : 0.5), cy + (sel ? 1 : 0.5), cw - (sel ? 2 : 1), ch - (sel ? 2 : 1));
      ctx.setLineDash([]);
    }
    function drawWave(ctx, c, m, x1, x2, by, bh, w) {
      const p = peaksFor(m);
      if (!p || !p.peaks.length) return;
      stats.waves++;
      const { peaks, perSec } = p;
      const n = peaks.length / 2;
      const mid = by + bh / 2;
      const gain = Math.pow(10, (c.props.volume || 0) / 20);
      ctx.fillStyle = colors.light ? 'rgba(10,40,30,0.55)' : 'rgba(170,235,210,0.75)';
      const xa = Math.max(0, Math.floor(x1));
      const xb = Math.min(w, Math.ceil(x2));
      for (let x = xa; x < xb; x++) {
        const s0 = model.sourceTime(c, tOf(x));
        const s1 = model.sourceTime(c, tOf(x + 1));
        let i0 = Math.floor((Math.min(s0, s1) / T) * perSec);
        let i1 = Math.ceil((Math.max(s0, s1) / T) * perSec);
        if (i1 <= i0) i1 = i0 + 1;
        i0 = Math.max(0, i0);
        i1 = Math.min(n, i1);
        let lo = 0;
        let hi = 0;
        for (let i = i0; i < i1; i++) { if (peaks[2 * i] < lo) lo = peaks[2 * i]; if (peaks[2 * i + 1] > hi) hi = peaks[2 * i + 1]; }
        const top = mid - Math.min(1, hi * gain) * (bh / 2);
        const bot = mid - Math.max(-1, lo * gain) * (bh / 2);
        ctx.fillRect(x, top, 1, Math.max(1, bot - top));
      }
    }
    function drawTop(ctx, w, h) {
      ctx.clearRect(0, 0, w, h);
      if (!seq) return;
      const d = v.drag;
      // ghosts of a move or a drop
      const ghosts = d?.type === 'move' && d.moved ? d.ghosts : v.drop?.ghosts;
      if (ghosts) {
        const insert = d?.type === 'move' ? d.insert : v.drop?.insert;
        for (const g of ghosts) {
          const r = rowOfTrack.get(g.track);
          if (!r) continue;
          const y = r.y - v.scrollY + 1;
          const x1 = xOf(g.start);
          const x2 = xOf(g.end);
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(x1, y, x2 - x1, r.h - 3);
          ctx.strokeStyle = '#ffffff';
          ctx.setLineDash(insert ? [4, 3] : []);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x1 + 0.75, y + 0.75, x2 - x1 - 1.5, r.h - 4.5);
          ctx.setLineDash([]);
        }
        if (insert && ghosts.length) {
          const x = xOf(Math.min(...ghosts.map((g) => g.start)));
          ctx.fillStyle = colors.accent;
          ctx.fillRect(Math.round(x) - 1, 0, 2, h);
          ctx.beginPath(); ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
        }
      }
      // a drop target: the clip an effect lands on, the edit point a transition lands on
      if (v.drop?.clip) {
        const r = rowOfTrack.get(v.drop.clip.track);
        if (r) {
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(xOf(v.drop.clip.start) + 1, r.y - v.scrollY + 2, pxOf(model.clipDuration(v.drop.clip)) - 2, r.h - 5);
        }
      }
      if (v.drop?.edge) {
        const r = rowOfTrack.get(v.drop.edge.track);
        if (r) {
          ctx.fillStyle = colors.accent;
          const [ta, tb] = transitionSpan(v.drop.edge);
          ctx.globalAlpha = 0.5;
          ctx.fillRect(xOf(ta), r.y - v.scrollY + 2, Math.max(3, pxOf(tb - ta)), r.h - 5);
          ctx.globalAlpha = 1;
        }
      }
      if (d?.type === 'marquee' && d.moved) {
        ctx.fillStyle = 'rgba(84, 138, 247, 0.15)';
        ctx.strokeStyle = colors.guide;
        ctx.lineWidth = 1;
        const x = Math.min(d.x0, d.x) - v.scrollX + d.sx0;
        const y = Math.min(d.y0, d.y) - v.scrollY + d.sy0;
        const rw = Math.abs(d.x - d.x0);
        const rh = Math.abs(d.y - d.y0);
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x + 0.5, y + 0.5, rw, rh);
      }
      if (app.tool === 'razor' && v.razorAt != null) {
        ctx.strokeStyle = colors.text;
        ctx.setLineDash([3, 3]);
        const x = Math.round(xOf(v.razorAt)) + 0.5;
        const r = v.razorRow;
        ctx.beginPath();
        if (v.razorAll || !r) { ctx.moveTo(x, 0); ctx.lineTo(x, h); } else { ctx.moveTo(x, r.y - v.scrollY); ctx.lineTo(x, r.y - v.scrollY + r.h); }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (v.guide != null) {
        ctx.fillStyle = colors.guide;
        ctx.fillRect(Math.round(xOf(v.guide)) - 0.5, 0, 1, h);
      }
      // ranges an automation is about to change, over the tracks it names (all of them when none)
      if (v.overlay?.ranges?.length) {
        const rows = v.overlay.tracks ? v.overlay.tracks.map((id) => rowOfTrack.get(id)).filter(Boolean) : null;
        ctx.fillStyle = colors.playhead;
        for (const [a, b] of v.overlay.ranges) {
          const x1 = xOf(a);
          const x2 = xOf(b);
          if (x2 < 0 || x1 > w) continue;
          const bw = Math.max(1, x2 - x1);
          ctx.globalAlpha = 0.28;
          if (rows) for (const r of rows) ctx.fillRect(x1, r.y - v.scrollY, bw, r.h);
          else ctx.fillRect(x1, 0, bw, h);
          ctx.globalAlpha = 0.9;
          ctx.fillRect(Math.round(x1) - 0.5, 0, 1, h);
          ctx.fillRect(Math.round(x2) - 0.5, 0, 1, h);
        }
        ctx.globalAlpha = 1;
      }
      // the playhead
      const px = xOf(app.t);
      if (px >= -1 && px <= w + 1) {
        ctx.fillStyle = colors.playhead;
        ctx.fillRect(Math.round(px) - 0.5, 0, 1, h);
      }
    }

    // ---------- track headers ----------
    function headButton(cls, iconName, title, pressed, run) {
      const b = el('button', `cut-tl-hb ${cls}`, undefined, { type: 'button', title, 'aria-label': title, 'aria-pressed': String(!!pressed) });
      if (ICONS[iconName]) b.appendChild(icon(iconName)); else b.textContent = iconName;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
      return b;
    }
    const setTrack = (id, patch) => ui.exec(app, C.setTrack(seq.id, id, patch));
    // Rebuilt only when what the headers show changes; a height change resizes them in place (a grip being dragged
    // must stay in the page or its pointer capture ends).
    let headsKey = null;
    const headOf = new Map();
    function buildHeads() {
      const patch = ui.patchFor(app);
      const targets = ui.editing.targets;
      const key = seq ? JSON.stringify([seq.id, rows.map((r) => [r.id, r.type, r.index, r.track && [r.track.name, r.track.locked, r.track.syncLock, r.track.visible, r.track.mute, r.track.solo], r.ct && [r.ct.name, r.ct.lang, r.ct.syncLock]]), patch, targets]) : '';
      if (key === headsKey) {
        for (const r of rows) {
          const n = headOf.get(r.id);
          if (!n) continue;
          n.style.height = `${r.h}px`;
          const vol = n.querySelector('.cut-tl-hvol');
          if (vol && r.track) showVolume(vol, r.track.volume, r.h);
        }
        return;
      }
      headsKey = key;
      headsInner.replaceChildren();
      headOf.clear();
      if (!seq) return;
      for (const r of rows) {
        const head = el('div', `cut-tl-head ${r.type}`);
        head.style.height = `${r.h}px`;
        head.dataset.row = r.id;
        headOf.set(r.id, head);
        if (r.type === 'divider') { headsInner.appendChild(head); continue; }
        if (r.type === 'caption') {
          head.append(el('span', 'cut-tl-hname', r.ct.name || r.ct.lang || tr('Captions')));
          head.appendChild(headButton('sync', 'sync', tr('Sync Lock'), r.ct.syncLock !== false, () => ui.exec(app, C.setCaptionTrack(seq.id, r.id, { syncLock: r.ct.syncLock === false }))));
          headsInner.appendChild(head);
          continue;
        }
        const t = r.track;
        const kind = r.type;
        const isPatched = patch[kind] === t.id;
        const isTarget = !targets || targets.includes(t.id);
        head.dataset.track = t.id;
        head.classList.toggle('locked', t.locked);
        const letter = kind === 'video' ? 'V' : 'A';
        // Premiere's order: source patch, track lock, track targeting, sync lock, then the output (video) or mute and
        // solo (audio).
        head.appendChild(headButton(`patch${isPatched ? ' on' : ''}`, `${letter}${r.index + 1}`, tr('Source Patch: place source clips on this track'), isPatched, () => {
          ui.setPatch(app, { [kind]: isPatched ? null : t.id });
        }));
        head.appendChild(headButton(`lock${t.locked ? ' on' : ''}`, t.locked ? 'lock' : 'unlock', tr('Toggle Track Lock'), t.locked, () => setTrack(t.id, { locked: !t.locked })));
        head.appendChild(headButton(`target${isTarget ? ' on' : ''}`, t.name, tr('Toggle Track Targeting'), isTarget, () => {
          const all = seq.tracks.map((x) => x.id);
          const now = new Set(ui.editing.targets || all);
          if (now.has(t.id)) now.delete(t.id); else now.add(t.id);
          ui.setTargets(app, now.size === all.length ? null : all.filter((id) => now.has(id)));
        }));
        head.appendChild(headButton(`sync${t.syncLock ? ' on' : ''}`, 'sync', tr('Toggle Sync Lock'), t.syncLock, () => setTrack(t.id, { syncLock: !t.syncLock })));
        if (kind === 'video') {
          head.appendChild(headButton(`eye${t.visible ? ' on' : ''}`, t.visible ? 'eye' : 'eyeOff', tr('Toggle Track Output'), t.visible, () => setTrack(t.id, { visible: !t.visible })));
        } else {
          head.appendChild(headButton(`mute${t.mute ? ' on' : ''}`, 'M', tr('Mute Track'), t.mute, () => setTrack(t.id, { mute: !t.mute })));
          head.appendChild(headButton(`solo${t.solo ? ' on' : ''}`, 'S', tr('Solo Track'), t.solo, () => setTrack(t.id, { solo: !t.solo })));
          head.appendChild(volumeControl(t, r.h));
        }
        const grip = el('div', 'cut-tl-hgrip', undefined, { title: tr('Drag to change the track height') });
        grip.addEventListener('pointerdown', (e) => startHeightDrag(e, t));
        head.appendChild(grip);
        head.addEventListener('dblclick', (e) => { if (!e.target.closest('button, .cut-tl-hvol')) renameTrack(t); });
        head.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(e, t); });
        headsInner.appendChild(head);
      }
      headsInner.style.transform = `translateY(${-v.scrollY}px)`;
    }
    function startHeightDrag(e, t) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const y0 = e.clientY;
      const h0 = t.height;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      app.history.begin('Track Height');
      const move = (ev) => {
        const nh = Math.round(Math.max(24, Math.min(240, h0 + ev.clientY - y0)));
        const cur = trackOf(app.sequence, t.id);
        if (cur && cur.height !== nh) {
          try { app.history.do(C.setTrack(seq.id, t.id, { height: nh })); } catch {}
        }
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('lostpointercapture', up);
        app.history.commit();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('lostpointercapture', up);
    }
    // ---------- track volume: a percent of the clips' level in the header; the model keeps dB (0% is -144 dB, which
    // the audio engine plays as silence) ----------
    const VOLUME_MAX = 200;
    const percentOf = (db) => (!(db > -144) ? 0 : 100 * Math.pow(10, (db ?? 0) / 20));
    const dbOf = (pct) => (pct <= 0 ? -144 : Math.round(2000 * Math.log10(pct / 100)) / 100);
    const clampPercent = (pct) => Math.max(0, Math.min(VOLUME_MAX, Math.round(pct)));
    const setVolume = (id, pct) => setTrack(id, { volume: dbOf(clampPercent(pct)) });
    function showVolume(node, db, h) {
      const pct = percentOf(db ?? 0);
      node.hidden = h < 44;
      node.querySelector('.cut-tl-hvol-fill').style.width = `${Math.min(100, (pct / VOLUME_MAX) * 100)}%`;
      node.querySelector('.cut-tl-hvol-text').textContent = `${Math.round(pct)}%`;
      node.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    async function askVolume(t) {
      const text = await ide.ui.prompt(tr('Track volume (0 to 200%)'), String(Math.round(percentOf(t.volume ?? 0))));
      if (text == null) return;
      const pct = Number(String(text).replace('%', '').trim());
      if (Number.isFinite(pct)) setVolume(t.id, pct);
    }
    // Dragging sideways changes the volume by the distance moved (the bar's width is 0 to 200%), so a click alone
    // changes nothing; double-click types a value, Alt+click is 100%.
    function volumeControl(t, h) {
      const node = el('div', 'cut-tl-hvol', undefined, { role: 'slider', 'aria-label': tr('Track Volume'), 'aria-valuemin': '0', 'aria-valuemax': String(VOLUME_MAX),
        title: tr('Track volume: drag sideways to change, double-click to type a value, Alt+click for 100%') });
      const bar = el('div', 'cut-tl-hvol-bar');
      bar.append(el('div', 'cut-tl-hvol-fill'), el('div', 'cut-tl-hvol-unity'));
      node.append(bar, el('span', 'cut-tl-hvol-text'));
      showVolume(node, t.volume, h);
      node.addEventListener('dblclick', (e) => { e.stopPropagation(); askVolume(trackOf(app.sequence, t.id) || t); });
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) { setVolume(t.id, 100); return; }
        const x0 = e.clientX;
        const p0 = percentOf(trackOf(app.sequence, t.id)?.volume ?? 0);
        const perPx = VOLUME_MAX / Math.max(40, bar.getBoundingClientRect().width);
        node.setPointerCapture(e.pointerId);
        app.history.begin('Track Volume');
        const move = (ev) => {
          const db = dbOf(clampPercent(p0 + (ev.clientX - x0) * perPx));
          const cur = trackOf(app.sequence, t.id);
          if (cur && cur.volume !== db) {
            try { app.history.do(C.setTrack(seq.id, t.id, { volume: db })); } catch {}
            showVolume(node, db, h);
          }
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('lostpointercapture', up);
          app.history.commit();
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('lostpointercapture', up);
      });
      return node;
    }
    async function renameTrack(t) {
      const name = await ide.ui.prompt(tr('Track name'), t.name);
      if (name != null && name.trim()) setTrack(t.id, { name: name.trim() });
    }
    function trackMenu(e, t) {
      const kind = t.kind;
      const index = model.trackIndex(seq, t.id);
      const hasClips = (byTrack.get(t.id) || []).length > 0;
      const heights = [[tr('Small'), 32], [tr('Medium'), kind === 'video' ? 56 : 48], [tr('Large'), 100]];
      ui.menu(e.clientX, e.clientY, [
        { label: tr('Rename…'), run: () => renameTrack(t) },
        { separator: true },
        { label: kind === 'video' ? tr('Add Video Track Above') : tr('Add Audio Track Below'), run: () => ui.exec(app, C.addTrack(seq.id, kind, index + 1)) },
        { label: kind === 'video' ? tr('Add Video Track Below') : tr('Add Audio Track Above'), run: () => ui.exec(app, C.addTrack(seq.id, kind, index)) },
        { label: tr('Delete Track'), disabled: seq.tracks.filter((x) => x.kind === kind).length <= 1, run: async () => {
          if (hasClips && !(await ide.ui.confirm(tr('Delete track {name} and its clips?', { name: t.name }), { ok: tr('Delete') }))) return;
          ui.exec(app, C.removeTrack(seq.id, t.id));
        } },
        { separator: true },
        ...(kind === 'audio' ? [{ label: tr('Track Volume'), submenu: [
          ...[0, 50, 100, 150, 200].map((p) => ({ label: `${p}%`, checked: Math.round(percentOf(t.volume ?? 0)) === p, run: () => setVolume(t.id, p) })),
          { separator: true },
          { label: tr('Set Volume…'), run: () => askVolume(t) },
        ] }] : []),
        { label: tr('Track Height'), submenu: heights.map(([label, hh]) => ({ label, checked: t.height === hh, run: () => setTrack(t.id, { height: hh }) })) },
        { label: tr('Make Every Track This Height'), run: () => {
          app.history.begin('Track Height');
          try { for (const x of seq.tracks) if (x.height !== t.height) app.history.do(C.setTrack(seq.id, x.id, { height: t.height })); } catch (err) { ui.report(err); } finally { app.history.commit(); }
        } },
      ]);
    }

    // ---------- the bar ----------
    function syncBar() {
      tools.hidden = !ide.settings.get(BAR_TOOLS_KEY, false);
      for (const [id, b] of toolButtons) b.setAttribute('aria-pressed', String(app.tool === id));
      snapBtn.setAttribute('aria-pressed', String(!!ui.editing.snapping));
      linkBtn.setAttribute('aria-pressed', String(v.linked));
      scroller.style.cursor = CURSORS[app.tool] || '';
    }
    function buildTabs() {
      const project = app.project;
      if (!project) { tabs.replaceChildren(); return; }
      v.tabs = v.tabs.filter((id) => project.sequences.some((s) => s.id === id));
      if (app.sequenceId && !v.tabs.includes(app.sequenceId)) v.tabs.push(app.sequenceId);
      tabs.replaceChildren(...v.tabs.map((id) => {
        const s = project.sequences.find((x) => x.id === id);
        const tab = el('div', `cut-tl-tab${id === app.sequenceId ? ' active' : ''}`, undefined, { 'data-seq': id, title: s.name });
        const name = el('span', 'cut-tl-tabname', s.name);
        name.dataset.userText = '';
        tab.appendChild(name);
        const x = el('button', 'cut-tl-tabclose', undefined, { type: 'button', title: tr('Close') });
        x.appendChild(icon('close'));
        x.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          v.tabs = v.tabs.filter((t) => t !== id);
          if (id === app.sequenceId && v.tabs.length) app.setSequence(v.tabs[v.tabs.length - 1]);
          buildTabs();
        });
        if (v.tabs.length > 1) tab.appendChild(x);
        tab.addEventListener('mousedown', (e) => { if (e.button === 0) app.setSequence(id); });
        return tab;
      }));
    }

    // ---------- hit testing ----------
    function hit(x, y) {
      const t = tOf(x);
      const row = rowAtY(y);
      const out = { x, y, t, row, clip: null, part: null };
      if (!row || !seq) return out;
      if (row.type === 'caption') {
        const items = row.ct.items;
        for (const it of items) {
          const xa = xOf(it.start);
          const xb = xOf(it.end);
          if (x >= xa - 4 && x <= xb + 4) {
            out.caption = it;
            out.part = x - xa < Math.min(EDGE, (xb - xa) / 3) ? 'start' : xb - x < Math.min(EDGE, (xb - xa) / 3) ? 'end' : 'body';
            if (x < xa || x > xb) out.part = x < xa ? 'start' : 'end';
            return out;
          }
        }
        return out;
      }
      if (!row.track) return out;
      const ry = row.y - v.scrollY;
      // transitions sit over the bottom of the clips
      for (const tr0 of seq.transitions) {
        if (tr0.track !== row.id) continue;
        const [ta, tb] = transitionSpan(tr0);
        const xa = xOf(ta);
        const xb = xOf(tb);
        const hh = Math.min(row.h - 4, 22);
        if (x >= xa - 3 && x <= xb + 3 && y >= ry + row.h - hh - 3) {
          out.transition = tr0;
          out.part = x - xa < 5 ? 'tstart' : xb - x < 5 ? 'tend' : 'tbody';
          return out;
        }
      }
      const list = byTrack.get(row.id) || [];
      let under = null;
      let near = null;
      for (const c of visible(list, tOf(x - EDGE), tOf(x + EDGE))) {
        const xa = xOf(c.start);
        const xb = xOf(model.clipEnd(c));
        const zone = Math.min(EDGE, (xb - xa) / 3);
        if (x >= xa && x < xb) under = c;
        if (Math.abs(x - xa) <= zone && (!near || Math.abs(x - xa) < near.d)) near = { c, edge: 'start', d: Math.abs(x - xa), inside: x >= xa };
        if (Math.abs(x - xb) <= zone && (!near || Math.abs(x - xb) < near.d || (Math.abs(x - xb) === near.d && x < xb))) near = { c, edge: 'end', d: Math.abs(x - xb), inside: x < xb };
      }
      if (under && showsBand(row) && y > ry + 15) {
        const kind = row.type;
        const prop = bandProp(kind);
        const list2 = under.keyframes?.[prop];
        if (list2?.length) {
          for (let i = 0; i < list2.length; i++) {
            const k = list2[i];
            const kx = xOf(under.start + k.t);
            const ky = bandY(prop, k.v, ry + 1, row.h - 3);
            if (Math.abs(kx - x) <= 5 && Math.abs(ky - y) <= 5) return { ...out, clip: under, part: 'kf', prop, kfIndex: i };
          }
        }
        if (kind === 'audio' && row.h >= 30) {
          const xa = xOf(under.start);
          const xb = xOf(model.clipEnd(under));
          const fy = ry + 1 + 15;
          if (y >= fy - 2 && y <= fy + 8) {
            if (Math.abs(x - (xa + pxOf(under.fadeIn))) <= 5) return { ...out, clip: under, part: 'fadeIn' };
            if (Math.abs(x - (xb - pxOf(under.fadeOut))) <= 5) return { ...out, clip: under, part: 'fadeOut' };
          }
        }
      }
      if (near && (!under || near.c === under || !near.inside || near.d < 3)) {
        out.clip = near.c;
        out.part = near.edge;
        return out;
      }
      if (under) {
        out.clip = under;
        out.part = 'body';
        if (showsBand(row) && y > ry + 15) {
          const prop = bandProp(row.type);
          const val = K.propValue(under, prop, t - under.start, under.props[prop]);
          if (Math.abs(bandY(prop, val, ry + 1, row.h - 3) - y) <= 3) { out.part = 'band'; out.prop = prop; }
        }
        return out;
      }
      return out;
    }
    const localXY = (e) => {
      const r = scroller.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // ---------- snapping ----------
    function points(exclude) {
      const pts = [app.t];
      if (app.inOut.in != null) pts.push(app.inOut.in);
      if (app.inOut.out != null) pts.push(app.inOut.out);
      for (const m of seq.markers) { pts.push(m.t); if (m.duration) pts.push(m.t + m.duration); }
      for (const c of seq.clips) {
        if (exclude?.has(c.id)) continue;
        pts.push(c.start, model.clipEnd(c));
        for (const mk of c.markers || []) pts.push(c.start + mk.t);
      }
      pts.sort((a, b) => a - b);
      return pts;
    }
    // The snap of moving times `cands` (ticks) by `delta`: -> {delta, at} with the guide's time, or the delta as is.
    function snapDelta(cands, delta, pts, enabled = ui.editing.snapping) {
      if (!enabled || !pts.length) return { delta, at: null };
      const lim = (SNAP_PX / v.pps) * T;
      let best = null;
      for (const c of cands) {
        const want = c + delta;
        let lo = 0;
        let hi = pts.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid] < want) lo = mid + 1; else hi = mid; }
        for (const i of [lo - 1, lo]) {
          if (i < 0 || i >= pts.length) continue;
          const d = pts[i] - want;
          if (Math.abs(d) <= lim && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: pts[i] };
        }
      }
      return best ? { delta: delta + best.d, at: best.at } : { delta, at: null };
    }

    // ---------- pointer gestures ----------
    const flash = (text) => ui.toast(text);
    const CLAMPS = { source: 'Source end', neighbour: 'The next clip is in the way', length: 'A clip is at least one frame long', speed: 'Speed must be between 1% and 10000%.' };
    // What a click on c selects: the members of its group and, with linked selection on, what they link to; with Alt
    // only c.
    function partnersOf(c, alt = false) {
      if (alt) return [c.id];
      const out = new Set([c]);
      if (c.group) for (const x of seq.clips) if (x.group === c.group) out.add(x);
      if (v.linked) for (const x of [...out]) for (const l of model.linkedClips(seq, x)) out.add(l);
      return [...out].map((x) => x.id);
    }
    function selectClip(c, e) {
      const group = partnersOf(c, e.altKey);
      if (e.shiftKey) {
        if (app.selection.has(c.id)) app.select([...app.selection].filter((id) => !group.includes(id)));
        else app.select(group, { add: true });
      } else if (!app.selection.has(c.id)) app.select(group);
      v.gap = null;
      setTransition(null);
    }
    function setTransition(id) {
      if (v.transition === id) return;
      v.transition = id;
      app.selectedTransition = id;
      app.emit('transitionSelection', { id });
      invalidate();
    }
    function gapAt(row, t) {
      if (!row?.track) return null;
      const list = byTrack.get(row.id) || [];
      if (list.some((c) => c.start <= t && t < model.clipEnd(c))) return null;
      const next = list.find((c) => c.start > t);
      if (!next) return null;
      let a = 0;
      for (const c of list) if (model.clipEnd(c) <= t) a = Math.max(a, model.clipEnd(c));
      return { track: row.id, a, b: next.start, t };
    }
    function onDown(e) {
      if (!seq) return;
      root.focus({ preventScroll: true });
      app.setFocus('timeline');
      const { x, y } = localXY(e);
      if (x > viewW() || y > viewH()) return; // the scrollbars
      if (e.button === 1 || (e.button === 0 && app.tool === 'hand')) {
        e.preventDefault();
        v.drag = { type: 'hand', cx: e.clientX, cy: e.clientY, sx: v.scrollX, sy: v.scrollY };
        scroller.setPointerCapture(e.pointerId);
        scroller.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      const h = hit(x, y);
      const tool = app.tool;
      if (tool === 'zoom') { zoomBy(e.altKey ? 1 / 2 : 2, { t: h.t, x }); return; }
      if (tool === 'razor') { razorAt(h, e); return; }
      if (tool === 'text') { addTextAt(h); return; }
      if (tool === 'trackForward' || tool === 'trackBackward') {
        const fwd = tool === 'trackForward';
        const t = h.t;
        const pick = seq.clips.filter((c) => (e.shiftKey ? c.track === h.row?.id : true) && (fwd ? model.clipEnd(c) > t : c.start < t));
        app.select(pick.map((c) => c.id));
        v.gap = null;
        setTransition(null);
        if (pick.length) startMove(e, x, y, pick.find((c) => c === h.clip) || pick[0]);
        return;
      }
      if (h.caption) { startCaption(e, h); return; }
      if (h.transition) {
        setTransition(h.transition.id);
        app.select([]);
        v.gap = null;
        if (h.part === 'tstart' || h.part === 'tend') startTransitionDrag(e, h);
        return;
      }
      if (h.clip && (tool === 'slip' || tool === 'slide')) { selectClip(h.clip, e); startSlipSlide(e, h, tool); return; }
      if (h.clip && tool === 'pen') {
        selectClip(h.clip, e);
        if (h.part === 'kf') startBand(e, h);
        else startPen(e, h);
        return;
      }
      if (h.clip && tool === 'rate' && (h.part === 'start' || h.part === 'end')) { selectClip(h.clip, e); startStretch(e, h); return; }
      if (h.clip && (h.part === 'kf' || h.part === 'band')) { selectClip(h.clip, e); startBand(e, h); return; }
      if (h.clip && (h.part === 'fadeIn' || h.part === 'fadeOut')) { selectClip(h.clip, e); startFade(e, h); return; }
      if (h.clip && (h.part === 'start' || h.part === 'end')) {
        const mode = tool === 'ripple' ? 'ripple' : tool === 'roll' ? 'roll' : e.ctrlKey ? 'ripple' : 'normal';
        selectClip(h.clip, e);
        startTrim(e, h, mode);
        return;
      }
      if (h.clip) {
        // A click on a clip already selected keeps the selection for a drag; released without moving it selects
        // just that clip (and its link). Ctrl toggles on release, so a Ctrl-drag (insert) never changes the selection.
        if (e.ctrlKey) v.pendingToggle = h.clip;
        else if (!e.shiftKey && app.selection.has(h.clip.id)) v.pendingSolo = { clip: h.clip, alt: e.altKey };
        else selectClip(h.clip, e);
        startMove(e, x, y, h.clip);
        return;
      }
      // empty: a marquee, or a click that picks a gap
      if (!e.shiftKey) app.select([]);
      setTransition(null);
      v.caption = null;
      v.drag = { type: 'marquee', x0: x + v.scrollX, y0: y + v.scrollY, x: x + v.scrollX, y: y + v.scrollY, sx0: 0, sy0: 0, base: e.shiftKey ? [...app.selection] : [], row: h.row, t: h.t, moved: false, alt: e.altKey };
      scroller.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      const { x, y } = localXY(e);
      const d = v.drag;
      if (!d) { hover(x, y, e); return; }
      if (d.type === 'hand') {
        setScroll(d.sx - (e.clientX - d.cx), d.sy - (e.clientY - d.cy));
        return;
      }
      d.lastEvent = e;
      if (d.type === 'marquee') {
        d.x = x + v.scrollX;
        d.y = y + v.scrollY;
        if (!d.moved && Math.hypot(d.x - d.x0, d.y - d.y0) > 3) d.moved = true;
        if (d.moved) marqueeSelect(d);
        autoScroll(x, y);
        invalidateTop();
        return;
      }
      if (d.step) scheduleStep(e);
    }
    let stepRaf = 0;
    function scheduleStep(e) {
      v.drag.pendingEvent = e;
      if (stepRaf) return;
      stepRaf = requestAnimationFrame(() => {
        stepRaf = 0;
        const d = v.drag;
        if (!d?.pendingEvent) return;
        const ev = d.pendingEvent;
        d.pendingEvent = null;
        d.step(ev);
      });
    }
    function onUp(e) {
      const d = v.drag;
      if (!d) return;
      if (stepRaf) { cancelAnimationFrame(stepRaf); stepRaf = 0; if (d.pendingEvent && d.step) d.step(d.pendingEvent); }
      v.drag = null;
      v.guide = null;
      try { scroller.releasePointerCapture(e.pointerId); } catch {}
      syncBar();
      tip.classList.remove('shown');
      if (d.type === 'marquee' && !d.moved) {
        const gap = gapAt(d.row, d.t);
        v.gap = gap;
        invalidate();
      } else if (d.end) d.end(e, false);
      if (v.pendingSolo) {
        const { clip: c, alt } = v.pendingSolo;
        v.pendingSolo = null;
        if (!d.moved) app.select(partnersOf(c, alt));
      }
      if (v.pendingToggle) {
        const c = v.pendingToggle;
        v.pendingToggle = null;
        if (!d.moved) {
          const group = partnersOf(c, e.altKey);
          if (app.selection.has(c.id)) app.select([...app.selection].filter((id) => !group.includes(id)));
          else app.select(group, { add: true });
        }
      }
      invalidate();
    }
    function cancelDrag() {
      const d = v.drag;
      if (!d) return;
      v.drag = null;
      v.guide = null;
      v.pendingToggle = null;
      v.pendingSolo = null;
      tip.classList.remove('shown');
      if (d.end) d.end(null, true);
      invalidate();
    }
    function hover(x, y, e) {
      if (!seq) return;
      const h = hit(x, y);
      const prevHover = v.hover?.clip;
      v.hover = h;
      if (app.tool === 'razor') {
        let t = snapT(h.t);
        if (ui.editing.snapping) { const s = snapDelta([t], 0, points(null)); t = s.delta + t; }
        v.razorAt = h.clip ? t : null;
        v.razorRow = h.row;
        v.razorAll = e.shiftKey;
        invalidateTop();
      }
      let cursor = CURSORS[app.tool] || '';
      if ((app.tool === 'slip' || app.tool === 'slide') && h.clip) cursor = app.tool === 'slip' ? 'ew-resize' : 'move';
      else if (app.tool === 'rate' && (h.part === 'start' || h.part === 'end')) cursor = 'col-resize';
      else if (app.tool === 'pen' && h.part === 'kf') cursor = 'move';
      else if (['select', 'ripple', 'roll', 'trackForward', 'trackBackward', 'rate'].includes(app.tool)) {
        if (h.part === 'start' || h.part === 'end') cursor = app.tool === 'roll' ? 'col-resize' : 'ew-resize';
        else if (h.part === 'tstart' || h.part === 'tend') cursor = 'ew-resize';
        else if (h.part === 'band') cursor = 'ns-resize';
        else if (h.part === 'kf') cursor = 'move';
        else if (h.part === 'fadeIn' || h.part === 'fadeOut') cursor = 'ew-resize';
      }
      if (scroller.style.cursor !== cursor) scroller.style.cursor = cursor;
      if (prevHover !== h.clip && rowOfTrack.get(h.clip?.track || prevHover?.track)?.type === 'audio') invalidate();
    }
    function autoScroll(x) {
      const w = viewW();
      if (x > w - 20) setScroll(v.scrollX + Math.min(40, (x - (w - 20)) * 2));
      else if (x < 20) setScroll(v.scrollX - Math.min(40, (20 - x) * 2));
    }
    function marqueeSelect(d) {
      const ta = tOf(Math.min(d.x0, d.x) - v.scrollX);
      const tb = tOf(Math.max(d.x0, d.x) - v.scrollX);
      const ya = Math.min(d.y0, d.y);
      const yb = Math.max(d.y0, d.y);
      const ids = new Set(d.base);
      for (const r of rows) {
        if (!r.track || r.y + r.h < ya || r.y > yb) continue;
        for (const c of byTrack.get(r.id) || []) {
          if (c.start < tb && model.clipEnd(c) > ta) for (const id of partnersOf(c, d.alt)) ids.add(id);
        }
      }
      if (ids.size !== app.selection.size || [...ids].some((id) => !app.selection.has(id))) app.select([...ids]);
    }
    function showTip(x, y, text) {
      tip.textContent = text;
      tip.style.left = `${Math.min(viewW() - 160, x + 14)}px`;
      tip.style.top = `${Math.max(0, y - 26)}px`;
      tip.classList.add('shown');
    }
    const fmtDelta = (d) => `${d < 0 ? '-' : '+'}${time.timecode(Math.abs(d), fps())}`;

    // move: ghosts while dragging, one command on release
    function startMove(e, x, y, grabbed) {
      const f = frame();
      const ids = app.selection.size ? [...app.selection] : [grabbed.id];
      const clips = ids.map((id) => clipById(seq, id)).filter(Boolean);
      if (!clips.includes(grabbed)) clips.push(grabbed);
      const exclude = new Set(clips.map((c) => c.id));
      const pts = points(exclude);
      const minStart = Math.min(...clips.map((c) => c.start));
      const maxEnd = Math.max(...clips.map((c) => model.clipEnd(c)));
      const grabRow = rowOfTrack.get(grabbed.track);
      const kind = grabRow.type;
      const kindRows = rowsOfKind(kind);
      const idxOf = (trackId) => rowOfTrack.get(trackId)?.index;
      const idxs = clips.filter((c) => rowOfTrack.get(c.track)?.type === kind).map((c) => idxOf(c.track));
      const minIdx = Math.min(...idxs);
      const maxIdx = Math.max(...idxs);
      const d = {
        type: 'move', moved: false, x0: x, y0: y, sx0: v.scrollX, clips, ghosts: [], insert: false, delta: 0, rows: 0,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 4) return;
          if (!d.moved) d.moved = true;
          autoScroll(p.x);
          let delta = Math.round((((p.x + v.scrollX) - (d.x0 + d.sx0)) / v.pps) * T / f) * f;
          if (minStart + delta < 0) delta = -minStart;
          const s = snapDelta([minStart, maxEnd, grabbed.start, model.clipEnd(grabbed)], delta, pts, ui.editing.snapping !== ev.shiftKey);
          delta = Math.max(-minStart, s.delta);
          v.guide = s.at;
          // rows: only within the grabbed clip's kind; the other kind stays on its tracks
          const pr = rowAtY(p.y);
          let dr = 0;
          if (pr && pr.type === kind) dr = (kind === 'video' ? 1 : 1) * (pr.index - grabRow.index);
          else if (pr && pr.y < grabRow.y && kind === 'audio') dr = -grabRow.index;
          else if (pr && pr.y > grabRow.y && kind === 'video') dr = -grabRow.index;
          dr = Math.max(-minIdx, Math.min(kindRows.length - 1 - maxIdx, dr));
          d.delta = delta;
          d.rows = dr;
          d.insert = ev.ctrlKey;
          d.copy = ev.altKey;
          d.ghosts = clips.map((c) => {
            const r = rowOfTrack.get(c.track);
            let track = c.track;
            if (r.type === kind && dr) track = kindRows.find((x) => x.index === r.index + dr)?.id || c.track;
            return { track, start: c.start + delta, end: model.clipEnd(c) + delta };
          });
          showTip(p.x, p.y, `${fmtDelta(delta)}${d.copy ? `  ${tr('Duplicate')}` : ''}${d.insert ? `  ${tr('Insert')}` : ''}`);
          invalidateTop();
        },
        end(ev, cancelled) {
          if (cancelled || !d.moved) return;
          const insert = !!ev?.ctrlKey;
          // Alt held at the drop: copies go there and the clips stay (Premiere's Alt+drag), linked and grouped among
          // themselves like the originals.
          if (ev?.altKey) {
            const copies = clips.map((c) => ({ ...clone(c), kind: kindOf(seq, c), trackIndex: model.trackIndex(seq, c.track) }));
            const opts = { at: minStart + d.delta, mode: insert ? 'insert' : 'overwrite' };
            for (const k of ['video', 'audio']) {
              const mine = copies.filter((c) => c.kind === k);
              if (!mine.length) continue;
              const list = seq.tracks.filter((t) => t.kind === k);
              opts[k] = list[Math.min(...mine.map((c) => c.trackIndex)) + (k === kind ? d.rows : 0)]?.id;
            }
            const r = ui.exec(app, C.paste(seq.id, copies, opts));
            if (r?.ids) app.select(r.ids);
            return;
          }
          if (!d.delta && !d.rows) return;
          const td = kind === 'video' ? { video: d.rows, audio: 0 } : { video: 0, audio: d.rows };
          ui.exec(app, C.move(seq.id, clips.map((c) => c.id), { delta: d.delta, trackDelta: td, insert, linked: false }));
        },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    // a live edit: begin a group, and on each step take back the last try and do the new one
    function liveEdit(label, apply) {
      app.history.begin(label);
      let open = true;
      return {
        set(cmd) {
          if (!open) return null;
          app.history.cancel();
          app.history.begin(label);
          try { return app.history.do(cmd) ?? {}; } catch (err) { return { error: err }; }
        },
        finish(keep) {
          if (!open) return;
          open = false;
          if (keep) app.history.commit(); else app.history.cancel();
        },
        apply,
      };
    }

    function startTrim(e, h, mode) {
      const c = h.clip;
      const edge = h.part;
      const linked = !e.altKey;
      const pos = edge === 'start' ? c.start : model.clipEnd(c);
      const exclude = new Set([c.id, ...model.linkedClips(seq, c).map((x) => x.id)]);
      if (mode === 'roll') {
        const partner = seq.clips.find((x) => x !== c && x.track === c.track && (edge === 'end' ? x.start === pos : model.clipEnd(x) === pos));
        if (partner) exclude.add(partner.id);
      }
      const pts = points(exclude);
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const live = liveEdit('Trim');
      const seqId = seq.id;
      const d = {
        type: 'trim', moved: false, clip: c, edge, mode,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.abs(p.x - x0) < 2) return;
          d.moved = true;
          autoScroll(p.x);
          let delta = Math.round(((p.x + v.scrollX - (x0 + sx0)) / v.pps) * T / f) * f;
          const s = snapDelta([pos], delta, pts, ui.editing.snapping !== ev.shiftKey);
          delta = s.delta;
          v.guide = s.at;
          const r = live.set(C.trim(seqId, c.id, { edge, delta, mode, linked }));
          // the edit point after this try: the program monitor shows the frames on either side of it
          const at = mode === 'ripple' && edge === 'start' ? pos : pos + (r?.applied ?? 0);
          app.emit('trimPreview', { clipId: c.id, edge, mode, t: at, active: true });
          ui.monitors?.program?.showTrim?.({ left: at >= f ? at - f : null, right: at });
          const why = r?.clamped ? ` — ${tr(CLAMPS[r.clamped] || 'Stopped')}` : r?.error ? ` — ${ui.errorText(r.error)}` : '';
          showTip(p.x, p.y, `${tr({ normal: 'Trim', ripple: 'Ripple Edit', roll: 'Rolling Edit' }[mode])} ${fmtDelta(r?.applied ?? 0)}${why}`);
          if (r?.clamped === 'source') d.clampedSource = true;
          invalidate();
        },
        end(ev, cancelled) {
          live.finish(!cancelled && d.moved);
          app.emit('trimPreview', { clipId: c.id, edge, mode, active: false });
          if (d.moved) ui.monitors?.program?.showTrim?.(null);
          if (!cancelled && d.clampedSource) flash(tr('Source end'));
        },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    // Rate Stretch (R) on an edge: live like a trim; the tip shows the speed the clip gets.
    function startStretch(e, h) {
      const c = h.clip;
      const edge = h.part;
      const linked = !e.altKey;
      const pos = edge === 'start' ? c.start : model.clipEnd(c);
      const pts = points(new Set([c.id, ...model.linkedClips(seq, c).map((x) => x.id)]));
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const live = liveEdit('Rate Stretch');
      const seqId = seq.id;
      const d = {
        type: 'stretch', moved: false,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.abs(p.x - x0) < 2) return;
          d.moved = true;
          autoScroll(p.x);
          let delta = Math.round(((p.x + v.scrollX - (x0 + sx0)) / v.pps) * T / f) * f;
          const s = snapDelta([pos], delta, pts, ui.editing.snapping !== ev.shiftKey);
          delta = s.delta;
          v.guide = s.at;
          const r = live.set(C.stretch(seqId, c.id, { edge, delta, linked }));
          const speed = clipById(app.sequence, c.id)?.speed ?? c.speed;
          const why = r?.clamped ? ` — ${tr(CLAMPS[r.clamped] || 'Stopped')}` : r?.error ? ` — ${ui.errorText(r.error)}` : '';
          showTip(p.x, p.y, `${tr('Rate Stretch')} ${Math.round(speed * 1000) / 10}%${why}`);
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled && d.moved); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    // Slip (Y) and Slide (U): a drag inside the clip. Slip shows the clip's new first and last frames in the program
    // monitor; dragging right shows earlier source, as the content moves with the pointer. Slide shows the frames on
    // either side of its new start.
    function startSlipSlide(e, h, tool) {
      const c = h.clip;
      const linked = !e.altKey;
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const seqId = seq.id;
      const live = liveEdit(tool === 'slip' ? 'Slip' : 'Slide');
      // the clip object changes with each try: its place when the drag began
      const s0 = c.start;
      const e0 = model.clipEnd(c);
      const touching = seq.clips.filter((x) => x.track === c.track && (model.clipEnd(x) === s0 || x.start === e0));
      const pts = points(new Set([c.id, ...model.linkedClips(seq, c).map((x) => x.id), ...touching.map((x) => x.id)]));
      const d = {
        type: tool, moved: false,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.abs(p.x - x0) < 2) return;
          d.moved = true;
          autoScroll(p.x);
          let delta = Math.round(((p.x + v.scrollX - (x0 + sx0)) / v.pps) * T / f) * f;
          if (tool === 'slide') {
            const s = snapDelta([s0, e0], delta, pts, ui.editing.snapping !== ev.shiftKey);
            delta = s.delta;
            v.guide = s.at;
          }
          const r = live.set(tool === 'slip' ? C.slip(seqId, c.id, { delta: -delta, linked }) : C.slide(seqId, c.id, { delta, linked }));
          const applied = r?.applied ?? 0;
          if (tool === 'slip') ui.monitors?.program?.showTrim?.({ left: s0, right: e0 - f });
          else ui.monitors?.program?.showTrim?.({ left: s0 + applied >= f ? s0 + applied - f : null, right: s0 + applied });
          if (r?.clamped === 'source') d.clampedSource = true;
          const why = r?.clamped ? ` — ${tr(CLAMPS[r.clamped] || 'Stopped')}` : r?.error ? ` — ${ui.errorText(r.error)}` : '';
          showTip(p.x, p.y, `${tr(tool === 'slip' ? 'Slip' : 'Slide')} ${fmtDelta(tool === 'slip' ? -applied : applied)}${why}`);
          invalidate();
        },
        end(ev, cancelled) {
          live.finish(!cancelled && d.moved);
          if (d.moved) ui.monitors?.program?.showTrim?.(null);
          if (!cancelled && d.clampedSource) flash(tr('Source end'));
        },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    // Pen (P): a click in a clip's keyframe area adds a keyframe of its line (volume, opacity) at that frame: on the
    // line, the line's value there; above or below it, the value of that height. Dragging on moves the new keyframe.
    function startPen(e, h) {
      const c = h.clip;
      const row = rowOfTrack.get(c.track);
      const ry = row.y - v.scrollY + 1;
      if (!showsBand(row) || h.y <= ry + 15) return;
      const prop = bandProp(row.type);
      const f = frame();
      const list = c.keyframes?.[prop] || [];
      const kt = Math.max(0, Math.min(model.clipDuration(c) - f, Math.round((h.t - c.start) / f) * f));
      const lineValue = K.propValue(c, prop, kt, c.props[prop]);
      const val = Math.abs(bandY(prop, lineValue, ry, row.h - 3) - h.y) <= 3 ? lineValue : bandValue(prop, h.y, ry, row.h - 3);
      const next = K.insert(list, { t: kt, v: val, ease: K.prev(list, kt)?.ease || 'linear' });
      const kfIndex = next.findIndex((k) => k.t === kt);
      const seqId = seq.id;
      const live = liveEdit('Keyframes');
      live.set(C.setKeyframes(seqId, c.id, prop, next));
      invalidate();
      const d = {
        type: 'pen', moved: false,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.hypot(p.x - h.x, p.y - h.y) < 3) return;
          d.moved = true;
          const lo = kfIndex > 0 ? next[kfIndex - 1].t + f : 0;
          const hi = kfIndex < next.length - 1 ? next[kfIndex + 1].t - f : model.clipDuration(c) - f;
          const t2 = Math.max(lo, Math.min(hi, Math.round((tOf(p.x) - c.start) / f) * f));
          const v2 = bandValue(prop, p.y, ry, row.h - 3);
          const moved = next.slice();
          moved[kfIndex] = { ...next[kfIndex], t: t2, v: v2 };
          live.set(C.setKeyframes(seqId, c.id, prop, moved));
          showTip(p.x, p.y, prop === 'volume' ? `${v2.toFixed(1)} dB` : `${Math.round(v2)}%`);
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled); invalidate(); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    function startFade(e, h) {
      const c = h.clip;
      const which = h.part;
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const base = c[which];
      const live = liveEdit('Fade');
      const seqId = seq.id;
      const d = {
        type: 'fade', moved: false,
        step(ev) {
          const p = localXY(ev);
          d.moved = true;
          const dx = p.x + v.scrollX - (x0 + sx0);
          const val = Math.max(0, Math.round((base + (which === 'fadeIn' ? dx : -dx) / v.pps * T) / f) * f);
          live.set(C.setClip(seqId, c.id, { [which]: val }, { linked: false }));
          showTip(p.x, p.y, `${which === 'fadeIn' ? tr('Fade In') : tr('Fade Out')} ${time.timecode(val, fps())}`);
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled && d.moved); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    // the keyframe line: drag it (no keyframes: the static value), drag a keyframe (time and value), Ctrl+click adds one
    function startBand(e, h) {
      const c = h.clip;
      const prop = h.prop || bandProp(rowOfTrack.get(c.track).type);
      const row = rowOfTrack.get(c.track);
      const seqId = seq.id;
      const f = frame();
      const list = c.keyframes?.[prop] || [];
      if (e.ctrlKey) {
        const kt = Math.max(0, Math.min(model.clipDuration(c) - f, Math.round((h.t - c.start) / f) * f));
        const val = K.propValue(c, prop, kt, c.props[prop]);
        ui.exec(app, C.setKeyframes(seqId, c.id, prop, K.insert(list, { t: kt, v: val, ease: K.prev(list, kt)?.ease || 'linear' })));
        return;
      }
      const live = liveEdit('Keyframes');
      const kfIndex = h.part === 'kf' ? h.kfIndex : null;
      const d = {
        type: 'band', moved: false,
        step(ev) {
          const p = localXY(ev);
          d.moved = true;
          const ry = row.y - v.scrollY + 1;
          const val = bandValue(prop, p.y, ry, row.h - 3);
          if (kfIndex == null) {
            if (list.length) {
              // the whole line moves by the same amount
              const v0 = K.propValue(c, prop, h.t - c.start, 0);
              const dv = val - v0;
              live.set(C.setKeyframes(seqId, c.id, prop, list.map((k) => ({ ...k, v: clampBand(prop, k.v + dv) }))));
            } else live.set(C.setClip(seqId, c.id, { props: { [prop]: val } }, { linked: false }));
          } else {
            const k = list[kfIndex];
            const lo = kfIndex > 0 ? list[kfIndex - 1].t + f : 0;
            const hi = kfIndex < list.length - 1 ? list[kfIndex + 1].t - f : model.clipDuration(c) - f;
            const kt = Math.max(lo, Math.min(hi, Math.round((tOf(p.x) - c.start) / f) * f));
            const next = list.slice();
            next[kfIndex] = { ...k, t: kt, v: val };
            live.set(C.setKeyframes(seqId, c.id, prop, next));
          }
          showTip(p.x, p.y, prop === 'volume' ? `${val.toFixed(1)} dB` : `${Math.round(val)}%`);
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled && d.moved); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }
    const clampBand = (prop, val) => Math.max(BAND[prop].lo, Math.min(BAND[prop].hi, Math.round(val * 10) / 10));

    function startTransitionDrag(e, h) {
      const tr0 = h.transition;
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const live = liveEdit('Transition Settings');
      const seqId = seq.id;
      const k = tr0.align === 'center' ? 2 : 1;
      const sign = h.part === 'tend' ? 1 : -1;
      const d = {
        type: 'tdur', moved: false,
        step(ev) {
          const p = localXY(ev);
          d.moved = true;
          const dx = (p.x + v.scrollX - (x0 + sx0)) * sign;
          const dur = Math.max(f, Math.round((tr0.duration + (dx / v.pps) * T * k) / f) * f);
          live.set(C.setTransition(seqId, tr0.id, { duration: dur }));
          showTip(p.x, p.y, `${tr('Duration')} ${time.timecode(dur, fps())}`);
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled && d.moved); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    function startCaption(e, h) {
      const row = h.row;
      const it = h.caption;
      v.caption = { track: row.id, id: it.id };
      app.select([]);
      app.emit('captionSelection', { track: row.id, id: it.id });
      const { x: x0 } = localXY(e);
      const sx0 = v.scrollX;
      const f = frame();
      const live = liveEdit('Edit Caption');
      const seqId = seq.id;
      const part = h.part;
      const pts = points(null);
      const d = {
        type: 'caption', moved: false,
        step(ev) {
          const p = localXY(ev);
          if (!d.moved && Math.abs(p.x - x0) < 3) return;
          d.moved = true;
          let delta = Math.round(((p.x + v.scrollX - (x0 + sx0)) / v.pps) * T / f) * f;
          const cands = part === 'start' ? [it.start] : part === 'end' ? [it.end] : [it.start, it.end];
          const s = snapDelta(cands, delta, pts, ui.editing.snapping !== ev.shiftKey);
          delta = s.delta;
          v.guide = s.at;
          let patch;
          if (part === 'start') patch = { start: Math.max(0, Math.min(it.end - f, it.start + delta)) };
          else if (part === 'end') patch = { end: Math.max(it.start + f, it.end + delta) };
          else { const dd = Math.max(-it.start, delta); patch = { start: it.start + dd, end: it.end + dd }; }
          live.set(C.setCaption(seqId, row.id, it.id, patch));
          invalidate();
        },
        end(ev, cancelled) { live.finish(!cancelled && d.moved); if (!d.moved) app.setTime(it.start); },
      };
      v.drag = d;
      scroller.setPointerCapture(e.pointerId);
    }

    function razorAt(h, e) {
      if (!h.clip) return;
      let t = snapT(h.t);
      if (ui.editing.snapping) t += snapDelta([t], 0, points(null)).delta;
      const r = e.shiftKey ? ui.exec(app, C.split(seq.id, t, { allTracks: true, linked: !e.altKey })) : ui.exec(app, C.split(seq.id, t, { clipIds: [h.clip.id], linked: !e.altKey }));
      if (r && !r.ids?.length) flash(tr('Nothing to cut here.'));
    }

    function addTextAt(h) {
      const row = h.row?.type === 'video' ? h.row : null;
      if (!row) { flash(tr('Click a video track to add text.')); return; }
      const at = snapT(h.t);
      const r = ui.exec(app, C.addGenerated(seq.id, { track: row.id, at, name: tr('Text'), source: { generator: 'text', layers: [{ text: tr('Title') }] } }));
      if (r?.id) {
        app.select([r.id]);
        app.setTool('select');
        app.setTime(at);
        ui.overlay?.editText?.(r.id);
      }
    }

    // ---------- drops from other panels ----------
    const offDrop = ui.dnd.target(lanes, {
      accepts: (p) => ['media', 'source', 'effect', 'transition', 'sequence', 'generator'].includes(p?.kind),
      over(p, e, info) {
        const { x, y } = localXY(e);
        v.drop = dropPlan(p, hit(x, y), info);
        invalidateTop();
      },
      leave() { v.drop = null; v.guide = null; invalidateTop(); },
      drop(p, e, info) {
        const { x, y } = localXY(e);
        const plan = dropPlan(p, hit(x, y), info);
        v.drop = null;
        v.guide = null;
        invalidateTop();
        if (plan) performDrop(p, plan, info);
      },
    });
    offs.push(offDrop);
    // Files dragged in from Explorer: imported (a file already in the project is used as it is) and placed where they
    // are dropped, as the project panel's items would be (Ctrl inserts). The window's own drop, which opens files in
    // the code editor, never sees them.
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    on(lanes, 'dragover', (e) => {
      if (!seq || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      const { x } = localXY(e);
      v.guide = snapT(tOf(x));
      invalidateTop();
    });
    on(lanes, 'dragleave', (e) => {
      if (lanes.contains(e.relatedTarget)) return;
      v.guide = null;
      invalidateTop();
    });
    on(lanes, 'drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      v.guide = null;
      invalidateTop();
      if (!seq) return;
      const { x, y } = localXY(e);
      const h = hit(x, y);
      const paths = [...e.dataTransfer.files].map((f) => { try { return ide.api.pathForFile(f); } catch { return null; } }).filter(Boolean);
      dropFiles(paths, h, { ctrl: e.ctrlKey }).catch((err) => ui.report(err));
    });
    async function dropFiles(paths, h, info) {
      const seqId = seq.id;
      const ids = await ui.media.mediaForPaths(app, paths);
      if (!ids.length || seq?.id !== seqId) return;
      const p = { kind: 'media', ids };
      const plan = dropPlan(p, h, info);
      v.guide = null;
      invalidateTop();
      if (plan) await performDrop(p, plan, info);
    }
    // The items a drop places: [{media, in, out, video, audio}] from a project selection or the source monitor.
    function dropItems(p) {
      if (p.kind === 'source') return [{ media: p.mediaId, in: p.in ?? null, out: p.out ?? null, video: p.video !== false, audio: p.audio !== false }];
      if (p.kind === 'media') return (p.ids || []).map((id) => ({ media: id, in: null, out: null, video: true, audio: true }));
      return [];
    }
    function itemLength(it) {
      const m = media.get(it.media);
      if (!m) return 0;
      if (m.kind === 'image') return app.project.settings.stillDuration;
      const a = it.in ?? 0;
      const b = it.out ?? m.duration;
      return Math.max(frame(), Math.floor((b - a) / frame()) * frame());
    }
    function dropTracks(row, it) {
      const m = media.get(it.media);
      const vids = rowsOfKind('video');
      const auds = rowsOfKind('audio');
      const patch = ui.patchFor(app);
      let vt = null;
      let at = null;
      if (row?.type === 'video') { vt = row.id; at = auds[Math.min(row.index, auds.length - 1)]?.id ?? null; }
      else if (row?.type === 'audio') { at = row.id; vt = vids[Math.min(row.index, vids.length - 1)]?.id ?? null; }
      else { vt = patch.video || vids[0]?.id || null; at = patch.audio || auds[0]?.id || null; }
      const hasV = m && (m.kind === 'image' || !!m.video);
      const hasA = !!m?.audio;
      return { video: hasV && it.video ? vt : null, audio: hasA && it.audio ? at : null };
    }
    function dropPlan(p, h, info) {
      if (!seq) return null;
      if (p.kind === 'effect') {
        const c = h.clip && !h.transition ? h.clip : null;
        return c ? { clip: c } : null;
      }
      if (p.kind === 'transition') {
        if (!h.row?.track) return null;
        const edge = edgeNear(h.row, h.t, p.type);
        return edge ? { edge } : null;
      }
      if (p.kind === 'sequence') return { refuse: tr('Nesting sequences comes in a later version.') };
      const items = p.kind === 'generator' ? [{ generator: p.source, length: p.duration || app.project.settings.stillDuration }] : dropItems(p);
      if (!items.length) return null;
      let at = snapT(h.t);
      const total = items.reduce((s, it) => s + (it.generator ? it.length : itemLength(it)), 0);
      const s = snapDelta([at, at + total], 0, points(null));
      at = Math.max(0, at + s.delta);
      v.guide = s.at;
      const ghosts = [];
      let cur = at;
      for (const it of items) {
        const len = it.generator ? it.length : itemLength(it);
        const tracks = it.generator ? { video: h.row?.type === 'video' ? h.row.id : ui.patchFor(app).video, audio: null } : dropTracks(h.row, it);
        for (const id of [tracks.video, tracks.audio]) if (id) ghosts.push({ track: id, start: cur, end: cur + len });
        it.tracks = tracks;
        cur += len;
      }
      return { items, at, ghosts, insert: !!info?.ctrl };
    }
    // The edit point a transition dropped at t goes on: a clip edge within 24 px, with its alignment.
    function edgeNear(row, t, type) {
      const list = byTrack.get(row.id) || [];
      let best = null;
      for (const c of list) {
        for (const at of [c.start, model.clipEnd(c)]) {
          const d = Math.abs(xOf(at) - xOf(t));
          if (d <= 24 && (!best || d < best.d)) best = { at, d };
        }
      }
      if (!best) return null;
      const before = list.some((c) => model.clipEnd(c) === best.at);
      const after = list.some((c) => c.start === best.at);
      const align = before && after ? 'center' : after ? 'start' : 'end';
      return { track: row.id, at: best.at, type, align, duration: app.project.settings.transitionDuration };
    }
    async function performDrop(p, plan, info) {
      if (plan.refuse) { flash(plan.refuse); return; }
      if (p.kind === 'effect') { applyEffect(plan.clip, p.type); return; }
      if (p.kind === 'transition') {
        const r = ui.exec(app, C.addTransition(seq.id, { track: plan.edge.track, at: plan.edge.at, type: p.type, align: plan.edge.align }));
        if (r?.id) setTransition(r.id);
        return;
      }
      await placeItems(plan.items, plan.at, info?.ctrl ? 'insert' : 'overwrite');
    }
    function applyEffect(c, type) {
      const def = effectDef(type);
      const kind = kindOf(seq, c);
      if (def && def.kind && def.kind !== kind) { flash(def.kind === 'audio' ? tr('This effect is for audio clips.') : tr('This effect is for video clips.')); return null; }
      const r = ui.exec(app, C.addEffect(seq.id, c.id, type));
      if (r) app.select([c.id]);
      return r;
    }
    let askedFit = new Set();
    // The first video placed in an empty sequence sets its size and rate; one placed in a sequence of other settings
    // asks once (the project panel's matchSequence, shared with the monitors). All in the drop's undo step.
    async function matchFirst(items) {
      const first = items.find((it) => !it.generator && media.get(it.media)?.video && media.get(it.media).kind === 'video');
      if (!first) return;
      if (ui.media?.matchSequence) { await ui.media.matchSequence(app, first.media); return; }
      const m = media.get(first.media);
      const vfps = m.video.fps && model.validFps(m.video.fps) ? m.video.fps : seq.fps;
      const differs = m.video.w !== seq.w || m.video.h !== seq.h || !same(vfps, seq.fps);
      if (!differs || (seq.clips.length && askedFit.has(seq.id))) return;
      if (seq.clips.length) {
        askedFit.add(seq.id);
        if (!(await ide.ui.confirm(tr('This clip does not match the sequence settings. Change the sequence to match the clip?'), { title: tr('Clip Mismatch'), ok: tr('Change Sequence Settings') }))) return;
      }
      app.history.do(C.setSequence(seq.id, { w: m.video.w - (m.video.w % 2), h: m.video.h - (m.video.h % 2), fps: vfps }));
    }
    async function placeItems(items, at, mode) {
      app.history.begin(mode === 'insert' ? 'Insert' : 'Overwrite');
      const made = [];
      try {
        await matchFirst(items);
        let cur = at;
        for (const it of items) {
          if (it.generator) {
            const r = app.history.do(C.addGenerated(app.sequence.id, { track: it.tracks.video, at: cur, duration: it.length, name: generatedName(it.generator), source: it.generator, mode }));
            made.push(r.id);
            cur += it.length;
            continue;
          }
          if (!it.tracks.video && !it.tracks.audio) continue;
          const r = app.history.do(C.place(app.sequence.id, { source: { media: it.media }, in: it.in ?? undefined, out: it.out ?? undefined, at: cur, video: it.tracks.video, audio: it.tracks.audio, mode }));
          made.push(...r.ids);
          cur = r.at + r.duration;
        }
        app.history.commit();
      } catch (err) {
        app.history.cancel();
        ui.report(err);
        return null;
      }
      if (made.length) app.select(made);
      return made;
    }

    // ---------- the ruler: playhead, markers ----------
    function rulerDown(e) {
      if (!seq || e.button !== 0) return;
      e.preventDefault();
      root.focus({ preventScroll: true });
      app.setFocus('timeline');
      const r = rulerBox.getBoundingClientRect();
      const x = e.clientX - r.left;
      const mh = markerHit(x, e.clientY - r.top);
      if (mh) { startMarkerDrag(e, mh.m, x, mh.part); return; }
      const scrub = (ev) => {
        const px = ev.clientX - r.left;
        let t = snapT(tOf(px));
        if (ev.shiftKey) {
          const s = snapDelta([t], 0, points(null), true);
          t += s.delta;
        }
        app.setTime(Math.max(0, t));
        if (px > rulerBox.clientWidth - 10) setScroll(v.scrollX + 20);
        else if (px < 10) setScroll(v.scrollX - 20);
      };
      scrub(e);
      rulerBox.setPointerCapture(e.pointerId);
      app.emit('scrub', { active: true });
      const move = (ev) => scrub(ev);
      const up = () => {
        rulerBox.removeEventListener('pointermove', move);
        rulerBox.removeEventListener('pointerup', up);
        rulerBox.removeEventListener('lostpointercapture', up);
        app.emit('scrub', { active: false });
      };
      rulerBox.addEventListener('pointermove', move);
      rulerBox.addEventListener('pointerup', up);
      rulerBox.addEventListener('lostpointercapture', up);
    }
    // The marker under a point of the ruler: its flag ('start'), or the end handle of a range marker ('end'). The
    // nearest wins; flags before ends.
    function markerHit(x, y) {
      if (!seq || y < 10 || y > 25) return null;
      let best = null;
      for (const m of seq.markers) {
        const d = Math.abs(xOf(m.t) - x);
        if (d <= 6 && (!best || d < best.d)) best = { m, part: 'start', d };
      }
      if (best) return best;
      for (const m of seq.markers) {
        if (!(m.duration > 0)) continue;
        const d = Math.abs(xOf(m.t + m.duration) - x);
        if (d <= 4 && (!best || d < best.d)) best = { m, part: 'end', d };
      }
      return best;
    }
    const markerAt = (x, y) => markerHit(x, y)?.m || null;
    // Dragging a marker moves it (a range marker keeps its length); dragging a range marker's end changes its length.
    // Both snap to frames and, with snapping on, to edit points, the playhead and other markers; one undo step on
    // release. A click without moving puts the playhead on the marker.
    function startMarkerDrag(e, mk, x0, part = 'start') {
      const f = frame();
      const target = rulerBox;
      target.setPointerCapture(e.pointerId);
      let moved = false;
      let t = mk.t;
      let duration = mk.duration;
      const own = part === 'end' ? mk.t + mk.duration : mk.t;
      const pts = points(null).filter((p) => p !== mk.t && p !== mk.t + mk.duration);
      const r = rulerBox.getBoundingClientRect();
      const move = (ev) => {
        const dx = ev.clientX - r.left - x0;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        let nt = Math.max(0, Math.round((own + (dx / v.pps) * T) / f) * f);
        nt += snapDelta([nt], 0, pts).delta;
        if (part === 'end') { nt = Math.max(mk.t + f, nt); duration = nt - mk.t; } else t = nt;
        v.guide = nt;
        v.markerDrag = { id: mk.id, t, duration };
        showTip(ev.clientX - scroller.getBoundingClientRect().left, 4, part === 'end' ? time.timecode(duration, fps()) : time.timecode(nt, fps()));
        invalidate();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('lostpointercapture', up);
        v.guide = null;
        v.markerDrag = null;
        tip.classList.remove('shown');
        if (moved && part === 'end' && duration !== mk.duration) ui.exec(app, C.setMarker(seq.id, mk.id, { duration }));
        else if (moved && part !== 'end' && t !== mk.t) ui.exec(app, C.setMarker(seq.id, mk.id, { t }));
        else if (!moved) app.setTime(part === 'end' ? mk.t + mk.duration : mk.t);
        invalidate();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('lostpointercapture', up);
    }
    on(rulerBox, 'pointerdown', rulerDown);
    on(rulerBox, 'dblclick', (e) => {
      const r = rulerBox.getBoundingClientRect();
      const mk = markerAt(e.clientX - r.left, e.clientY - r.top);
      if (mk) editMarker(mk);
    });
    on(rulerBox, 'contextmenu', (e) => {
      e.preventDefault();
      if (!seq) return;
      const r = rulerBox.getBoundingClientRect();
      const mk = markerAt(e.clientX - r.left, e.clientY - r.top);
      const setMk = (patch) => ui.exec(app, C.setMarker(seq.id, mk.id, patch));
      const items = mk ? [
        { label: tr('Edit Marker…'), run: () => editMarker(mk) },
        { label: tr('Color'), submenu: Object.keys(MARKER_COLORS).map((k) => ({ label: tr(MARKER_NAMES[k]), checked: mk.color === k, run: () => setMk({ color: k }) })) },
        { label: tr('Type'), submenu: [['comment', 'Comment'], ['chapter', 'Chapter'], ['beat', 'Beat']].map(([k, label]) => ({ label: tr(label), checked: mk.kind === k, run: () => setMk({ kind: k }) })) },
        { separator: true },
        { label: tr('Remove Marker'), run: () => ui.exec(app, C.removeMarker(seq.id, mk.id)) },
      ] : [
        { label: tr('Add Marker'), keyAction: 'Cut.addMarker', run: () => api.addMarker() },
        { separator: true },
        { label: tr('Lift'), keyAction: 'Cut.lift', disabled: app.inOut.in == null && app.inOut.out == null, run: () => api.liftRange('lift') },
        { label: tr('Extract'), keyAction: 'Cut.extract', disabled: app.inOut.in == null && app.inOut.out == null, run: () => api.liftRange('extract') },
        { label: tr('Clear In and Out'), keyAction: 'Cut.clearInOut', disabled: app.inOut.in == null && app.inOut.out == null, run: () => app.setInOut({ in: null, out: null }) },
      ];
      ui.menu(e.clientX, e.clientY, items);
    });
    // The marker dialog is the markers panel's (ui-markers.js).
    const editMarker = (mk) => ui.markers?.edit?.(app, mk.id);

    // ---------- context menus on the lanes ----------
    on(scroller, 'contextmenu', (e) => {
      e.preventDefault();
      if (!seq) return;
      const { x, y } = localXY(e);
      const h = hit(x, y);
      app.setFocus('timeline');
      if (h.transition) { setTransition(h.transition.id); transitionMenu(e, h.transition); return; }
      if (h.clip && h.part === 'kf') { keyframeMenu(e, h.clip, h.prop, h.kfIndex); return; }
      if (h.clip) {
        if (!app.selection.has(h.clip.id)) selectClip(h.clip, e);
        clipMenu(e, h.clip);
        return;
      }
      const gap = gapAt(h.row, h.t);
      v.gap = gap;
      invalidate();
      ui.menu(e.clientX, e.clientY, [
        { label: tr('Close Gap'), disabled: !gap, run: () => api.deleteSelection({ ripple: true }) },
        { label: tr('Paste'), disabled: !clipboard.length, run: () => api.paste() },
        { label: tr('Paste Insert'), keyAction: 'Cut.pasteInsert', disabled: !clipboard.length, run: () => api.paste({ insert: true }) },
        { separator: true },
        { label: tr('Add Video Track'), run: () => ui.exec(app, C.addTrack(seq.id, 'video')) },
        { label: tr('Add Audio Track'), run: () => ui.exec(app, C.addTrack(seq.id, 'audio')) },
      ]);
    });
    function clipMenu(e, c) {
      const ids = [...app.selection];
      const clips = ids.map((id) => clipById(seq, id)).filter(Boolean);
      const linkedAny = clips.some((x) => x.link);
      const kind = kindOf(seq, c);
      const m = media.get(c.source?.media);
      ui.menu(e.clientX, e.clientY, [
        { label: tr('Cut'), keyAction: 'Cut.cut', run: () => api.cut() },
        { label: tr('Copy'), keyAction: 'Cut.copy', run: () => api.copy() },
        { label: tr('Paste'), keyAction: 'Cut.paste', disabled: !clipboard.length, run: () => api.paste() },
        { label: tr('Paste Insert'), keyAction: 'Cut.pasteInsert', disabled: !clipboard.length, run: () => api.paste({ insert: true }) },
        { label: tr('Clear'), keyAction: 'Cut.delete', run: () => api.deleteSelection({ ripple: false }) },
        { label: tr('Ripple Delete'), keyAction: 'Cut.rippleDelete', run: () => api.deleteSelection({ ripple: true }) },
        { separator: true },
        { label: tr('Enable'), checked: c.enabled, keyAction: 'Cut.toggleEnabled', run: () => api.toggleEnabled() },
        { label: linkedAny ? tr('Unlink') : tr('Link'), keyAction: 'Cut.link', disabled: !linkedAny && clips.length < 2, run: () => api.toggleLink() },
        { label: tr('Group'), keyAction: 'Cut.group', disabled: clips.length < 2, run: () => api.group() },
        { label: tr('Ungroup'), keyAction: 'Cut.ungroup', disabled: !clips.some((x) => x.group), run: () => api.ungroup() },
        { separator: true },
        { label: tr('Label'), submenu: [{ label: tr('None'), checked: !c.label, run: () => setLabel(null) }, ...Object.keys(LABELS).map((k) => ({ label: tr(LABEL_NAMES[k]), checked: c.label === k, run: () => setLabel(k) }))] },
        { separator: true },
        { label: tr('Speed/Duration…'), keyAction: 'Cut.speed', run: () => api.speedDialog() },
        { label: tr('Speed'), disabled: !clips.some((x) => !model.isStill(app.project, x)), submenu: [
          ...QUICK_SPEEDS.map((p) => ({ label: `${p}%`, checked: Math.abs(c.speed * 100 - p) < 1e-6, run: () => api.setSpeed({ speed: p / 100 }) })),
          { separator: true },
          { label: tr('Reverse Speed'), checked: !!c.reverse, run: () => api.setSpeed({ reverse: !c.reverse }) },
        ] },
        { label: tr('Insert Frame Hold Segment'), keyAction: 'Cut.freezeFrame', disabled: kind !== 'video' || !m || m.kind === 'image' || !edit.inClip(app, c), run: () => api.freezeFrame() },
        { label: tr('Apply Default Transitions to Selection'), keyAction: 'Cut.transitionBoth', run: () => api.addTransitions({ video: true, audio: true }) },
        { separator: true },
        { label: tr('Rename…'), run: () => renameClip(c) },
        { separator: true },
        { label: tr('Reveal in Source Monitor'), disabled: !m, run: () => openInSource(c) },
        { label: tr('Match Frame'), keyAction: 'Cut.matchFrame', disabled: !m || !edit.inClip(app, c), run: () => api.matchFrame() },
        ...(ui.auto ? [{ separator: true }, ...ui.auto.clipMenuItems(app, c)] : []),
      ]);
      function setLabel(label) {
        app.history.begin('Clip Settings');
        try { for (const x of clips) app.history.do(C.setClip(seq.id, x.id, { label })); } catch (err) { ui.report(err); } finally { app.history.commit(); }
      }
    }
    // A keyframe of a clip's line: its interpolation, and Delete.
    function keyframeMenu(e, c, prop, index) {
      const list = c.keyframes?.[prop] || [];
      const k = list[index];
      if (!k) return;
      const seqId = seq.id;
      ui.menu(e.clientX, e.clientY, [
        ...edit.EASES.map(([ease, label]) => ({ label: tr(label), checked: (k.ease || 'linear') === ease, run: () => ui.exec(app, C.setKeyframes(seqId, c.id, prop, edit.easeList(list, [k.t], ease))) })),
        { separator: true },
        { label: tr('Delete Keyframe'), run: () => { const left = K.remove(list, k.t); ui.exec(app, C.setKeyframes(seqId, c.id, prop, left.length ? left : null)); } },
      ]);
    }
    function transitionMenu(e, tr0) {
      ui.menu(e.clientX, e.clientY, [
        { label: tr('Alignment'), submenu: [['center', tr('Center at Cut')], ['start', tr('Start at Cut')], ['end', tr('End at Cut')]].map(([a, label]) => ({ label, checked: tr0.align === a, run: () => ui.exec(app, C.setTransition(seq.id, tr0.id, { align: a })) })) },
        { label: tr('Set Duration…'), run: async () => {
          const text = await ide.ui.prompt(tr('Transition duration (timecode or frames)'), time.timecode(tr0.duration, fps()));
          const d = text == null ? null : time.parseTimecode(text, fps(), 0);
          if (d) ui.exec(app, C.setTransition(seq.id, tr0.id, { duration: d }));
        } },
        { separator: true },
        { label: tr('Clear'), hint: 'Delete', run: () => { ui.exec(app, C.removeTransition(seq.id, tr0.id)); setTransition(null); } },
      ]);
    }
    async function renameClip(c) {
      const name = await ide.ui.prompt(tr('Clip name'), c.name);
      if (name != null) ui.exec(app, C.setClip(seq.id, c.id, { name }));
    }
    function openInSource(c) {
      const m = media.get(c.source?.media);
      if (!m) return;
      app.setSource({ mediaId: m.id, in: m.kind === 'image' ? null : c.in, out: m.kind === 'image' ? null : c.out, t: c.in });
    }
    on(scroller, 'dblclick', (e) => {
      if (!seq || app.tool !== 'select') return;
      const { x, y } = localXY(e);
      const h = hit(x, y);
      if (h.transition) { setTransition(h.transition.id); app.emit('transitionSelection', { id: h.transition.id, open: true }); return; }
      if (!h.clip) return;
      if (h.clip.source?.generator === 'text') { app.setTime(Math.max(app.t, h.clip.start)); ui.overlay?.editText?.(h.clip.id); return; }
      openInSource(h.clip);
    });

    on(scroller, 'pointerdown', onDown);
    on(scroller, 'pointermove', onMove);
    on(scroller, 'pointerup', onUp);
    on(scroller, 'lostpointercapture', (e) => { if (v.drag) onUp(e); });
    on(scroller, 'pointerleave', () => { if (!v.drag && v.razorAt != null) { v.razorAt = null; invalidateTop(); } });
    on(window, 'keydown', (e) => {
      if (e.key === 'Escape' && v.drag) { e.preventDefault(); e.stopPropagation(); cancelDrag(); return; }
      if (e.key === 'Alt' && v.drag?.type === 'move') e.preventDefault();
      if ((e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') && v.drag?.type === 'move' && v.drag.lastEvent) scheduleStep(new PointerEvent('pointermove', { clientX: v.drag.lastEvent.clientX, clientY: v.drag.lastEvent.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }));
    }, true);
    on(root, 'pointerdown', () => app.setFocus('timeline'), true);

    // ---------- clipboard ----------
    // Copied clips name their media by id, and another project's m2 is another file (or none): they paste only into the
    // project they came from. The clipboard outlived opening another project and pasted that project's file.
    let copied = [];
    let copiedFrom = null;
    const clipboard = { get length() { return copiedFrom === app.history ? copied.length : 0; } };
    function copySelection() {
      const clips = [...app.selection].map((id) => clipById(seq, id)).filter(Boolean);
      copied = clips.map((c) => ({ ...clone(c), kind: kindOf(seq, c), trackIndex: model.trackIndex(seq, c.track) }));
      copiedFrom = app.history;
      return copied.length;
    }

    // ---------- app events ----------
    const remember = () => { if (seq) v.perSeq.set(seq.id, { pps: v.pps, scrollX: v.scrollX, scrollY: v.scrollY }); };
    offs.push(app.on('project', ({ reason }) => {
      rebuild();
      buildTabs();
      if (!['do', 'undo', 'redo'].includes(reason)) { askedFit = new Set(); v.perSeq.clear(); v.tabs = app.sequenceId ? [app.sequenceId] : []; buildTabs(); requestAnimationFrame(() => zoomFit()); }
      if (v.transition && !seq?.transitions.some((x) => x.id === v.transition)) setTransition(null);
      if (v.gap) v.gap = gapAt(rowOfTrack.get(v.gap.track), v.gap.t);
    }));
    offs.push(app.on('sequence', () => {
      remember();
      rebuild();
      buildTabs();
      const saved = seq && v.perSeq.get(seq.id);
      setTransition(null);
      v.gap = null;
      if (saved) { v.pps = saved.pps; layoutSizer(); setScroll(saved.scrollX, saved.scrollY); zoomRange.value = String(Math.round(ppsToRange(v.pps))); } else requestAnimationFrame(() => zoomFit());
    }));
    offs.push(app.on('time', ({ t }) => {
      tc.value = t;
      // follow the playhead a page at a time while playing (and when it jumps out of view)
      const x = xOf(t);
      if (!v.drag && (x < 0 || x > viewW() - 4)) setScroll(app.playing ? (t / T) * v.pps - 8 : (t / T) * v.pps - viewW() / 2);
      dirtyRuler = true;
      invalidateTop();
    }));
    offs.push(app.on('selection', () => invalidate()));
    offs.push(app.on('inout', () => invalidate()));
    offs.push(app.on('tool', () => { syncBar(); v.razorAt = null; invalidateTop(); }));
    offs.push(app.on('snapping', () => syncBar()));
    offs.push(ide.on('settingsChanged', (k) => { if (k === BAR_TOOLS_KEY) syncBar(); }));
    offs.push(app.on('patch', () => buildHeads()));
    offs.push(app.on('targets', () => buildHeads()));
    offs.push(app.on('offline', () => invalidate()));
    const themeObs = new MutationObserver(() => { readColors(); invalidate(); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    offs.push(() => themeObs.disconnect());

    // ---------- what keys and other panels call ----------
    const sel = () => [...app.selection].map((id) => clipById(seq, id)).filter(Boolean);
    const api = {
      root,
      view: v,
      stats,
      get sequence() { return seq; },
      xOf, tOf, hit,
      rowOf: (trackId) => { const r = rowOfTrack.get(trackId); return r ? { y: r.y - v.scrollY, h: r.h } : null; },
      clientPoint(t, trackId, dy = 0.5) {
        const r = rowOfTrack.get(trackId);
        const box = scroller.getBoundingClientRect();
        return { x: box.left + xOf(t), y: box.top + (r ? r.y - v.scrollY + r.h * dy : 0) };
      },
      setZoom: (pps, anchor) => setZoom(pps, anchor),
      setScroll: (x, y) => setScroll(x, y),
      zoomIn: () => zoomBy(1.6),
      zoomOut: () => zoomBy(1 / 1.6),
      zoomFit,
      get snap() { return !!ui.editing.snapping; },
      toggleSnap: () => ui.setSnapping(app, !ui.editing.snapping),
      setTool: (t) => app.setTool(t),
      get selectedTransition() { return v.transition; },
      selectTransition: (id) => setTransition(id),
      get gap() { return v.gap; },
      split({ allTracks = false } = {}) {
        if (!seq) return null;
        const t = app.t;
        if (allTracks) return ui.exec(app, C.split(seq.id, t, { allTracks: true }));
        const under = sel().filter((c) => c.start < t && t < model.clipEnd(c));
        if (under.length) return ui.exec(app, C.split(seq.id, t, { clipIds: under.map((c) => c.id), linked: false }));
        return ui.exec(app, C.split(seq.id, t, { trackIds: targeted(seq), linked: v.linked }));
      },
      rippleTrim(side) {
        if (!seq) return null;
        const r = ui.exec(app, C.rippleToPlayhead(seq.id, app.t, side, { trackIds: targeted(seq) }));
        if (r?.range && side === 'before') app.setTime(r.range[0]);
        return r;
      },
      deleteSelection({ ripple = false } = {}) {
        if (!seq) return null;
        if (v.transition) {
          const r = ui.exec(app, C.removeTransition(seq.id, v.transition));
          setTransition(null);
          return r;
        }
        if (v.caption) {
          const r = ui.exec(app, C.removeCaption(seq.id, v.caption.track, v.caption.id));
          v.caption = null;
          return r;
        }
        const clips = sel();
        if (!clips.length && v.gap) {
          const r = ui.exec(app, C.closeGap(seq.id, v.gap.track, v.gap.t));
          v.gap = null;
          return r;
        }
        if (!clips.length) return null;
        const r = ui.exec(app, C.remove(seq.id, clips.map((c) => c.id), { ripple, linked: false }));
        if (r) app.select([]);
        return r;
      },
      toggleEnabled() {
        const clips = sel();
        if (!clips.length) return null;
        const on = !clips.every((c) => c.enabled);
        app.history.begin('Clip Settings');
        try { for (const c of clips) app.history.do(C.setClip(seq.id, c.id, { enabled: on })); } catch (err) { ui.report(err); } finally { app.history.commit(); }
        return { enabled: on };
      },
      toggleLink() {
        const clips = sel();
        if (!clips.length) return null;
        if (clips.some((c) => c.link)) return ui.exec(app, C.unlink(seq.id, clips.map((c) => c.id)));
        return ui.exec(app, C.link(seq.id, clips.map((c) => c.id)));
      },
      copy: () => copySelection(),
      cut() {
        if (!copySelection()) return null;
        return api.deleteSelection({ ripple: false });
      },
      paste({ insert = false } = {}) {
        if (!seq || !clipboard.length) return null;
        const t = targeted(seq);
        const lowest = (kind) => seq.tracks.filter((x) => x.kind === kind && t.includes(x.id))[0]?.id;
        const opts = { at: app.t, mode: insert ? 'insert' : 'overwrite' };
        if (copied.some((c) => c.kind === 'video') && lowest('video')) opts.video = lowest('video');
        if (copied.some((c) => c.kind === 'audio') && lowest('audio')) opts.audio = lowest('audio');
        const r = ui.exec(app, C.paste(seq.id, copied, opts));
        if (r?.ids) app.select(r.ids);
        return r;
      },
      get clipboard() { return clipboard.length ? copied.slice() : []; },
      selectAll: () => seq && app.select(seq.clips.map((c) => c.id)),
      deselect: () => { app.select([]); setTransition(null); v.gap = null; invalidate(); },
      freezeFrame() {
        if (!seq) return null;
        const c = sel().find((x) => kindOf(seq, x) === 'video' && edit.inClip(app, x)) || model.clipsAt(seq, app.t, { kind: 'video' }).reverse().find((x) => targeted(seq).includes(x.track));
        if (!c) { flash(tr('Put the playhead on a video clip.')); return null; }
        const r = ui.exec(app, C.freezeFrame(seq.id, c.id, app.t));
        if (r?.id) app.select([r.id]);
        return r;
      },
      // Default transitions: at both ends of the selected clips, else at the edit point nearest the playhead on each
      // targeted track of the kind.
      addTransitions({ video = true, audio = false, type: given = null } = {}) {
        if (!seq) return null;
        const kinds = [video && 'video', audio && 'audio'].filter(Boolean);
        const type = (kind) => given || ide.settings.get(kind === 'video' ? 'cut.defaultVideoTransition' : 'cut.defaultAudioTransition', '') || defaultTransition(kind);
        const plan = [];
        const clips = sel().filter((c) => kinds.includes(kindOf(seq, c)));
        if (clips.length) {
          for (const c of clips) for (const at of [c.start, model.clipEnd(c)]) plan.push({ track: c.track, at, kind: kindOf(seq, c) });
        } else {
          for (const id of targeted(seq)) {
            const tk = trackOf(seq, id);
            if (!kinds.includes(tk.kind)) continue;
            let best = null;
            for (const c of byTrack.get(id) || []) for (const at of [c.start, model.clipEnd(c)]) if (!best || Math.abs(at - app.t) < Math.abs(best - app.t)) best = at;
            if (best !== null) plan.push({ track: id, at: best, kind: tk.kind });
          }
        }
        const seen = new Set();
        const todo = plan.filter((p) => { const k = `${p.track}@${p.at}`; if (seen.has(k)) return false; seen.add(k); return true; });
        if (!todo.length) { flash(tr('There is no edit point here.')); return null; }
        app.history.begin('Add Transition');
        const ids = [];
        try {
          for (const p of todo) {
            const list = byTrack.get(p.track) || [];
            const before = list.some((c) => model.clipEnd(c) === p.at);
            const after = list.some((c) => c.start === p.at);
            const r = app.history.do(C.addTransition(seq.id, { track: p.track, at: p.at, type: type(p.kind), align: before && after ? 'center' : after ? 'start' : 'end' }));
            ids.push(r.id);
          }
          app.history.commit();
        } catch (err) {
          app.history.cancel();
          ui.report(err);
          return null;
        }
        return { ids };
      },
      speedDialog: () => speedDialog(),
      setSpeed: (patch) => setSpeed(patch),
      addMarker() {
        if (!seq) return null;
        const c = sel().find((x) => edit.inClip(app, x));
        const r = c ? ui.exec(app, C.addMarker(seq.id, { t: app.t }, { clipId: c.id })) : ui.exec(app, C.addMarker(seq.id, { t: app.t }));
        return r;
      },
      // Lift (;) and Extract ('): the sequence In to Out (one point missing: the start or the end) off the targeted
      // tracks; the playhead goes to the In, which is cleared with the Out.
      liftRange(kind = 'lift') {
        if (!seq) return null;
        const { in: a, out: b } = app.inOut;
        if (a == null && b == null) { flash(tr('Set an In and an Out point.')); return null; }
        const tracks = targeted(seq);
        if (!tracks.length) { flash(tr('Choose a target track.')); return null; }
        const r = ui.exec(app, (kind === 'extract' ? C.extract : C.lift)(seq.id, a ?? 0, b ?? seqEnd(), tracks));
        if (r?.range) {
          app.setInOut({ in: null, out: null });
          app.setTime(r.range[0]);
        }
        return r;
      },
      // Alt+Left/Right: the selected clips by n frames, as a drag would move them (overwriting what they land on).
      nudge(n) {
        const clips = sel();
        if (!seq || !clips.length) return null;
        return ui.exec(app, C.move(seq.id, clips.map((c) => c.id), { delta: n * frame(), linked: false, nudge: true }));
      },
      // Alt+Up/Down: the selected clips one track up or down (video toward V2, audio toward A1 for Up), overwriting
      // what they land on; a kind with no track there stays.
      nudgeTrack(dir) {
        const clips = sel();
        if (!seq || !clips.length) return null;
        const count = (kind) => seq.tracks.filter((t) => t.kind === kind).length;
        const idx = (c) => rowOfTrack.get(c.track)?.index ?? 0;
        const step = (kind, d) => {
          const list = clips.filter((c) => kindOf(seq, c) === kind).map(idx);
          return list.length && Math.min(...list) + d >= 0 && Math.max(...list) + d < count(kind) ? d : 0;
        };
        const td = { video: step('video', dir), audio: step('audio', -dir) };
        if (!td.video && !td.audio) { flash(tr('There is no track there.')); return null; }
        return ui.exec(app, C.move(seq.id, clips.map((c) => c.id), { delta: 0, trackDelta: td, linked: false }));
      },
      // Ctrl+= and Ctrl+- (video), Alt+= and Alt+- (audio): every track of the kind a step taller or shorter; Shift+=
      // expands every track and Shift+- minimizes it. One undo step.
      trackHeights(kind, how) {
        if (!seq) return null;
        const ids = seq.tracks.filter((t) => !kind || t.kind === kind).map((t) => t.id);
        const next = (h) => (how === 'taller' ? h + TRACK_H.step : how === 'shorter' ? h - TRACK_H.step : how === 'expand' ? TRACK_H.expanded : TRACK_H.min);
        const seqId = seq.id;
        app.history.begin('Track Height');
        try {
          for (const id of ids) {
            const t = trackOf(app.sequence, id);
            const h = Math.max(TRACK_H.min, Math.min(TRACK_H.max, next(t.height)));
            if (h !== t.height) app.history.do(C.setTrack(seqId, id, { height: h }));
          }
          app.history.commit();
        } catch (err) {
          app.history.cancel();
          ui.report(err);
          return null;
        }
        return ids.map((id) => trackOf(app.sequence, id).height);
      },
      group() {
        const clips = sel();
        if (clips.length < 2) { flash(tr('Choose two or more clips to group.')); return null; }
        return ui.exec(app, C.group(seq.id, clips.map((c) => c.id)));
      },
      ungroup() {
        const clips = sel().filter((c) => c.group);
        if (!clips.length) { flash(tr('No selected clip is in a group.')); return null; }
        return ui.exec(app, C.ungroup(seq.id, clips.map((c) => c.id)));
      },
      // D: the clips under the playhead on the targeted tracks, with their groups and (linked selection) links.
      selectAtPlayhead() {
        if (!seq) return [];
        const t = app.t;
        const tracks = targeted(seq);
        const ids = new Set();
        for (const c of seq.clips) if (tracks.includes(c.track) && c.start <= t && t < model.clipEnd(c)) for (const id of partnersOf(c)) ids.add(id);
        app.select([...ids]);
        v.gap = null;
        setTransition(null);
        return [...ids];
      },
      // F: the source of the clip under the playhead (the selected one, else the top video clip on the targeted
      // tracks, else the first one with a source) in the source monitor at the same source frame, its In/Out marked.
      matchFrame() {
        if (!seq) return null;
        const t = app.t;
        const tracks = targeted(seq);
        const under = model.clipsAt(seq, t).filter((c) => c.source?.media != null && media.get(c.source.media));
        const video = (c) => kindOf(seq, c) === 'video';
        const c = under.find((x) => app.selection.has(x.id)) || under.filter((x) => video(x) && tracks.includes(x.track)).pop()
          || under.find((x) => tracks.includes(x.track)) || under.filter(video).pop() || under[0];
        if (!c) { flash(tr('There is no source clip under the playhead.')); return null; }
        const m = media.get(c.source.media);
        const image = m.kind === 'image';
        const st = image ? 0 : model.sourceTime(c, t);
        app.setSource({ mediaId: m.id, in: image ? null : c.in, out: image ? null : c.out, t: st });
        ui.showPanel?.('source');
        ui.monitors?.source?.seek?.(st);
        return { clipId: c.id, mediaId: m.id, t: st };
      },
      // E: the selected clips' edit point nearest the playhead (none selected: the nearest on the targeted tracks)
      // rolls to the playhead, or its clip end trims there when nothing touches it.
      extendEdit() {
        if (!seq) return null;
        const clips = sel();
        const opts = clips.length ? { clipIds: clips.map((c) => c.id), linked: v.linked } : { trackIds: targeted(seq), linked: v.linked };
        const r = ui.exec(app, C.extendEdit(seq.id, app.t, opts));
        if (r?.clamped) flash(tr(CLAMPS[r.clamped] || 'Stopped'));
        return r;
      },
      editPoints() {
        if (!seq) return [];
        const set = new Set([0]);
        for (const c of seq.clips) { set.add(c.start); set.add(model.clipEnd(c)); }
        return [...set].sort((a, b) => a - b);
      },
      applyEffect: (clipId, type) => { const c = clipById(seq, clipId); return c ? applyEffect(c, type) : null; },
      placeItems: (items, at, mode) => placeItems(items.map((it) => ({ ...it, tracks: it.tracks || dropTracks(it.row ? rowOfTrack.get(it.row) : null, it) })), at, mode),
      cancelDrag,
      invalidate,
      get overlay() { return v.overlay; },
      setOverlay(o) { v.overlay = o?.ranges ? { ranges: o.ranges.map((r) => [r[0], r[1]]), tracks: o.tracks || null } : null; invalidateTop(); },
      dispose() {},
    };

    // The clip menu's Speed submenu: the selected clips (stills have no speed) get a speed or reverse, later clips
    // moving along, in one undo step. A linked pair changes once, through either clip.
    function setSpeed(patch) {
      const done = new Set();
      const clips = sel().filter((x) => !model.isStill(app.project, x));
      if (!clips.length) { flash(tr('Select a clip first.')); return false; }
      app.history.begin('Clip Settings');
      try {
        for (const x of clips) {
          if (done.has(x.id)) continue;
          for (const l of [x, ...model.linkedClips(seq, x)]) done.add(l.id);
          app.history.do(C.setClip(seq.id, x.id, { ...patch, ripple: true }));
        }
        app.history.commit();
      } catch (err) {
        app.history.cancel();
        ui.report(err);
        return false;
      }
      return true;
    }

    function speedDialog() {
      const clips = sel();
      if (!clips.length) { flash(tr('Select a clip first.')); return null; }
      const c = clips[0];
      const still = model.isStill(app.project, c);
      const speed = ui.numberField({ value: Math.round(c.speed * 1000) / 10, min: 1, max: 10000, step: 1, precision: 1, unit: '%' });
      const durF = ui.timecodeField({ fps, value: model.clipDuration(c) });
      const reverse = el('input', null, undefined, { type: 'checkbox' });
      reverse.checked = c.reverse;
      const ripple = el('input', null, undefined, { type: 'checkbox' });
      ripple.checked = true;
      const body = el('div', 'cut-form');
      if (!still) body.append(ui.row(tr('Speed'), speed));
      body.append(ui.row(tr('Duration'), durF));
      if (!still) body.append(ui.row(tr('Reverse Speed'), reverse));
      body.append(ui.row(tr('Ripple Edit, Shifting Trailing Clips'), ripple));
      const d0 = model.clipDuration(c);
      ui.dialog({
        title: tr('Clip Speed / Duration'), body, width: 400,
        buttons: [
          { label: tr('OK'), primary: true, run: () => {
            // Enter in a field presses OK before the field takes its value: let it take it first.
            for (const n of body.querySelectorAll('input.cut-number-input, input.cut-timecode-input')) n.blur();
            app.history.begin('Clip Settings');
            try {
              for (const x of clips) {
                const patch = { ripple: ripple.checked };
                if (!still && Math.abs(speed.value / 100 - c.speed) > 1e-9) patch.speed = speed.value / 100;
                else if (durF.value !== d0) patch.duration = durF.value;
                if (!still && reverse.checked !== x.reverse) patch.reverse = reverse.checked;
                if (Object.keys(patch).length > 1) app.history.do(C.setClip(seq.id, x.id, patch));
              }
              app.history.commit();
            } catch (err) {
              app.history.cancel();
              ui.report(err);
              return false;
            }
            return undefined;
          } },
          { label: tr('Cancel') },
        ],
      });
      return true;
    }

    // keys: the actions ui-keys.js dispatches (Cut.ui.onAction), while the timeline or the program monitor has them
    const EDIT = ['timeline', 'program'];
    const act = (id, fn, panels = EDIT) => offs.push(ui.onAction(id, (ctx) => fn(ctx), { panels }));
    act('split', () => { api.split(); });
    act('splitAll', () => { api.split({ allTracks: true }); });
    act('rippleStart', () => { api.rippleTrim('before'); });
    act('rippleEnd', () => { api.rippleTrim('after'); });
    act('rippleDelete', () => { api.deleteSelection({ ripple: true }); }, ['timeline']);
    act('delete', () => { api.deleteSelection({ ripple: false }); }, ['timeline']);
    act('toggleEnabled', () => { api.toggleEnabled(); });
    act('link', () => { api.toggleLink(); });
    act('speed', () => { api.speedDialog(); });
    act('freezeFrame', () => { api.freezeFrame(); });
    act('transitionVideo', () => { api.addTransitions({ video: true }); });
    act('transitionAudio', () => { api.addTransitions({ video: false, audio: true }); });
    act('transitionBoth', () => { api.addTransitions({ video: true, audio: true }); });
    act('copy', () => { api.copy(); }, ['timeline']);
    act('cut', () => { api.cut(); }, ['timeline']);
    act('paste', () => { api.paste(); }, ['timeline']);
    act('pasteInsert', () => { api.paste({ insert: true }); }, ['timeline']);
    act('lift', () => { api.liftRange('lift'); });
    act('extract', () => { api.liftRange('extract'); });
    for (const [id, n] of [['nudgeLeft', -1], ['nudgeRight', 1], ['nudgeLeft5', -5], ['nudgeRight5', 5]]) act(id, () => { api.nudge(n); }, ['timeline']);
    act('nudgeUp', () => { api.nudgeTrack(1); }, ['timeline']);
    act('nudgeDown', () => { api.nudgeTrack(-1); }, ['timeline']);
    for (const [id, kind, how] of [['videoTracksTaller', 'video', 'taller'], ['videoTracksShorter', 'video', 'shorter'], ['audioTracksTaller', 'audio', 'taller'],
      ['audioTracksShorter', 'audio', 'shorter'], ['expandTracks', null, 'expand'], ['minimizeTracks', null, 'minimize']]) act(id, () => { api.trackHeights(kind, how); }, ['timeline']);
    act('group', () => { api.group(); }, ['timeline']);
    act('ungroup', () => { api.ungroup(); }, ['timeline']);
    act('selectAtPlayhead', () => { api.selectAtPlayhead(); });
    act('matchFrame', () => { api.matchFrame(); });
    act('extendEdit', () => { api.extendEdit(); });
    act('selectAll', () => { api.selectAll(); }, ['timeline']);
    act('deselect', () => { api.deselect(); }, ['timeline']);
    act('zoomIn', () => { api.zoomIn(); }, ['timeline']);
    act('zoomOut', () => { api.zoomOut(); }, ['timeline']);
    act('zoomFit', () => { api.zoomFit(); }, ['timeline']);

    current = api;
    rebuild();
    buildTabs();
    syncBar();
    requestAnimationFrame(() => zoomFit());
    return {
      dispose() {
        for (const off of offs.splice(0)) { try { off(); } catch {} }
        root.remove();
        if (current === api) current = null;
      },
      focus() { root.focus({ preventScroll: true }); },
    };
  }

  function defaultTransition(kind) {
    try {
      if (Cut.effects?.defaultTransition) return Cut.effects.defaultTransition(kind);
      const list = Cut.effects?.transitions?.() || [];
      const d = list.find((x) => (x.kind || 'video') === kind && /dissolve|crossfade|constant/i.test(x.type)) || list.find((x) => (x.kind || 'video') === kind);
      if (d) return d.type;
    } catch {}
    return kind === 'audio' ? 'audio.crossfade' : 'dissolve';
  }

  // Cut.ui.timeline: the mounted timeline's API (null-safe calls for the other panels and the tests).
  ui.timeline = new Proxy({}, {
    get(_, key) {
      if (key === 'current') return current;
      if (key === 'LABELS') return LABELS;
      if (key === 'MARKER_COLORS') return MARKER_COLORS;
      if (key === 'MARKER_NAMES') return MARKER_NAMES;
      if (!current) return typeof key === 'string' && !['then', 'toJSON'].includes(key) ? () => null : undefined;
      return current[key];
    },
  });
  ui.registerPanel('timeline', { title: () => tr('Timeline'), mount });
})();
