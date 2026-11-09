// The source and program monitors (video-editor-features.md section 4). Both draw through Cut.player: the program
// monitor plays the active sequence of the editor's app; the source monitor plays one media file through an app of
// its own whose project holds just that file on a sequence of its size and rate, so source time is that sequence's
// time. Each has a timecode field, a scrub bar with its In/Out, the transport buttons, safe margins (action 93%,
// title 90%), zoom, playback quality, a dropped-frames count and full screen. The source monitor also has Insert and
// Overwrite (',' '.') and handles to drag the clip, or only its video or audio, onto the timeline.
//
// The button bar under the picture follows Premiere Pro's default set and order (Add Marker, Mark In, Mark Out, Go to In,
// Step Back, Play-Stop, Step Forward, Go to Out, then Insert and Overwrite in the source monitor or Lift and Extract in
// the program monitor, and Export Frame). Its "+" opens the Button Editor, which adds or takes away buttons (Loop, Play
// In to Out, Clear In/Out, the edit and marker steps...); the choice is the setting `cut.<source|program>.buttons`.
//
// Cut.ui.monitors: { source, program }, each { el, player, app, fullscreen() }; program.showTrim({left, right} | null)
// shows two sequence frames side by side while the timeline trims (the frames on either side of the edit point), slips
// (the clip's first and last frame) or slides; program.trimTimes is what it shows.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, icon, button } = ui;
  const log = ide.logger('#cut');
  const T = () => Cut.time;

  const SHUTTLE = [1, 2, 4, 8];
  const ZOOMS = ['fit', 25, 50, 75, 100, 150, 200, 400];
  const QUALITIES = [[1, 'Full'], [0.5, '1/2'], [0.25, '1/4']];
  const PROGRAM_PANELS = ['program', 'timeline', 'controls', 'effects', 'color', 'scopes', 'text', 'captions', 'export', 'tools'];

  // ---------- the button bar ----------
  // Glyphs for the buttons ui-base has none for. Constant markup only.
  const svg = (body) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const GLYPHS = {
    addMarker: svg('<path d="M4 2.5h8v8L8 14l-4-3.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'),
    lift: svg('<rect x="1.5" y="10" width="13" height="3.5" rx=".5" stroke="currentColor"/><rect x="5" y="10" width="6" height="3.5" fill="currentColor" opacity=".35"/><path d="M8 8.5V2M5.5 4.5 8 2l2.5 2.5" stroke="currentColor" stroke-width="1.3"/>'),
    extract: svg('<rect x="1.5" y="10" width="4" height="3.5" rx=".5" stroke="currentColor"/><rect x="10.5" y="10" width="4" height="3.5" rx=".5" stroke="currentColor"/><path d="M8 8.5V2M5.5 4.5 8 2l2.5 2.5" stroke="currentColor" stroke-width="1.3"/><path d="M6 11.75h4" stroke="currentColor" stroke-dasharray="1 1"/>'),
    clearIn: svg('<path d="M4 2.5v11M4 2.5h4M4 13.5h4" stroke="currentColor" stroke-width="1.4"/><path d="m9.5 6 4 4M13.5 6l-4 4" stroke="currentColor" stroke-width="1.2"/>'),
    clearOut: svg('<path d="M12 2.5v11M12 2.5H8M12 13.5H8" stroke="currentColor" stroke-width="1.4"/><path d="m2.5 6 4 4M6.5 6l-4 4" stroke="currentColor" stroke-width="1.2"/>'),
    markClip: svg('<path d="M3 2.5v11M3 2.5h3M3 13.5h3M13 2.5v11M13 2.5h-3M13 13.5h-3" stroke="currentColor" stroke-width="1.4"/><rect x="6" y="6" width="4" height="4" fill="currentColor" opacity=".6"/>'),
    prevEdit: svg('<path d="M3 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M13 3.5v9L6 8z" fill="currentColor"/><path d="M3 8h2" stroke="currentColor"/>'),
    nextEdit: svg('<path d="M13 3v10" stroke="currentColor" stroke-width="1.4"/><path d="M3 3.5v9L10 8z" fill="currentColor"/><path d="M11 8h2" stroke="currentColor"/>'),
    prevMarker: svg('<path d="M9.5 3h4v5L11.5 10 9.5 8z" stroke="currentColor" stroke-linejoin="round"/><path d="M7.5 4v8L2 8z" fill="currentColor"/>'),
    nextMarker: svg('<path d="M2.5 3h4v5L4.5 10 2.5 8z" stroke="currentColor" stroke-linejoin="round"/><path d="M8.5 4v8L14 8z" fill="currentColor"/>'),
    editor: svg('<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5"/>'),
  };
  const glyph = (name) => {
    if (!GLYPHS[name]) return icon(name);
    const span = el('span', 'ide-icon cut-icon');
    span.dataset.iconName = name;
    span.innerHTML = GLYPHS[name];
    return span;
  };
  // Every button a monitor can show, in the order the bar shows them. kinds: the monitors that have it.
  const BUTTONS = [
    { id: 'addMarker', title: 'Add Marker', glyph: 'addMarker', kinds: ['program'] },
    { id: 'markIn', title: 'Mark In', glyph: 'markIn' },
    { id: 'markOut', title: 'Mark Out', glyph: 'markOut' },
    { id: 'markClip', title: 'Mark Clip', glyph: 'markClip', kinds: ['program'] },
    { id: 'clearIn', title: 'Clear In', glyph: 'clearIn' },
    { id: 'clearOut', title: 'Clear Out', glyph: 'clearOut' },
    { id: 'goIn', title: 'Go to In', glyph: 'goIn' },
    { id: 'prevMarker', title: 'Go to Previous Marker', glyph: 'prevMarker', kinds: ['program'] },
    { id: 'prevEdit', title: 'Go to Previous Edit Point', glyph: 'prevEdit', kinds: ['program'] },
    { id: 'frameBack', title: 'Step Back One Frame', glyph: 'stepBack' },
    { id: 'playPause', title: 'Play/Stop', glyph: 'play' },
    { id: 'frameForward', title: 'Step Forward One Frame', glyph: 'stepForward' },
    { id: 'nextEdit', title: 'Go to Next Edit Point', glyph: 'nextEdit', kinds: ['program'] },
    { id: 'nextMarker', title: 'Go to Next Marker', glyph: 'nextMarker', kinds: ['program'] },
    { id: 'goOut', title: 'Go to Out', glyph: 'goOut' },
    { id: 'playInToOut', title: 'Play In to Out', glyph: 'playInOut' },
    { id: 'loop', title: 'Loop', glyph: 'loop' },
    { id: 'insert', title: 'Insert', glyph: 'insert', kinds: ['source'] },
    { id: 'overwrite', title: 'Overwrite', glyph: 'overwrite', kinds: ['source'] },
    { id: 'lift', title: 'Lift', glyph: 'lift', kinds: ['program'] },
    { id: 'extract', title: 'Extract', glyph: 'extract', kinds: ['program'] },
    { id: 'exportFrame', title: 'Export Frame', glyph: 'frame' },
  ];
  // Premiere Pro's default button bars. The source monitor has no Add Marker: Cut has no markers on media files.
  const DEFAULT_BUTTONS = {
    source: ['markIn', 'markOut', 'goIn', 'frameBack', 'playPause', 'frameForward', 'goOut', 'insert', 'overwrite', 'exportFrame'],
    program: ['addMarker', 'markIn', 'markOut', 'goIn', 'frameBack', 'playPause', 'frameForward', 'goOut', 'lift', 'extract', 'exportFrame'],
  };
  const buttonsKey = (kind) => `cut.${kind}.buttons`;
  const availableButtons = (kind) => BUTTONS.filter((b) => !b.kinds || b.kinds.includes(kind));
  // The buttons a monitor shows: the saved choice (Play/Stop always), else the default.
  function shownButtons(kind) {
    const v = ide.settings.get(buttonsKey(kind), null);
    const ok = new Set(availableButtons(kind).map((b) => b.id));
    const list = Array.isArray(v) ? v.filter((id) => ok.has(id)) : DEFAULT_BUTTONS[kind];
    return list.includes('playPause') ? list : [...list, 'playPause'];
  }
  // The Button Editor: a box per button; OK keeps the choice, Reset Layout goes back to Premiere's set.
  function buttonEditor(kind) {
    const shown = new Set(shownButtons(kind));
    const body = el('div', 'cut-button-editor');
    body.appendChild(el('div', 'cut-dialog-note', tr('Choose the buttons under the picture.')));
    const boxes = new Map();
    const grid = el('div', 'cut-button-editor-list');
    for (const b of availableButtons(kind)) {
      const row = el('label', 'cut-button-editor-row', undefined, { 'data-button': b.id });
      const box = el('input', null, undefined, { type: 'checkbox' });
      box.checked = shown.has(b.id);
      box.disabled = b.id === 'playPause';
      boxes.set(b.id, box);
      row.append(box, glyph(b.glyph), el('span', null, tr(b.title)));
      grid.appendChild(row);
    }
    body.appendChild(grid);
    ui.dialog({
      title: tr('Button Editor'),
      id: 'cutButtonEditor',
      body,
      width: 440,
      buttons: [
        { label: tr('OK'), primary: true, run: () => { ide.settings.set(buttonsKey(kind), availableButtons(kind).map((b) => b.id).filter((id) => boxes.get(id).checked)); } },
        { label: tr('Reset Layout'), run: () => { for (const [id, box] of boxes) box.checked = DEFAULT_BUTTONS[kind].includes(id) || id === 'playPause'; return false; } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- a player for an app ----------
  // The engine's player when it is there. Without it, a clock that moves the playhead (nothing is drawn), so the
  // screen still works while the engine is missing.
  function makePlayer(app, canvas) {
    let audio = null;
    try { audio = Cut.audioengine?.create?.(app) || null; } catch (err) { log.warn(`audio engine: ${err?.message || err}`); }
    if (Cut.player?.create) {
      // captions: the track shown in the captions panel, the one export burns in, drawn by the same code (word
      // highlight included)
      try { return Cut.player.create({ app, canvas, audio, captions: () => ui.captions?.trackOf(app)?.id || true }); } catch (err) { log.error(`player: ${err?.stack || err}`); }
    }
    let raf = 0;
    let last = 0;
    const p = {
      playing: false, rate: 1, quality: 1, dropped: 0, fallback: true,
      play(rate = 1) {
        p.rate = rate;
        if (p.playing) return;
        p.playing = true;
        app.setPlaying(true);
        last = performance.now();
        const tick = (now) => {
          if (!p.playing) return;
          app.setTime(Math.max(0, app.t + T().fromSeconds(((now - last) / 1000) * p.rate)));
          last = now;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      pause() { p.playing = false; cancelAnimationFrame(raf); app.setPlaying(false); },
      seek(t) { app.setTime(t); },
      setQuality(q) { p.quality = q; },
      destroy() { p.pause(); },
    };
    return p;
  }

  // ---------- one monitor ----------
  // spec: {kind: 'source' | 'program', app (whose time is shown), editor (the editor's app), duration(), fps(),
  // inOut() -> {in, out}, setInOut(patch), name()}
  function monitor(root, spec) {
    const { kind } = spec;
    root.classList.add('cut-monitor', `cut-monitor-${kind}`);
    const head = el('div', 'cut-monitor-head');
    const title = el('span', 'cut-monitor-title');
    title.dataset.userText = '';
    head.appendChild(title);
    const view = el('div', 'cut-monitor-view');
    const frame = el('div', 'cut-monitor-frame');
    const canvas = el('canvas', 'cut-monitor-canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const wave = el('canvas', 'cut-monitor-wave');
    wave.hidden = true;
    const safe = el('div', 'cut-safe');
    safe.append(el('div', 'cut-safe-action'), el('div', 'cut-safe-title'));
    safe.hidden = !ide.settings.get(`cut.${kind}.safe`, false);
    const trim = el('div', 'cut-trim-view');
    trim.hidden = true;
    frame.append(canvas, wave, safe);
    const empty = el('div', 'cut-monitor-empty');
    empty.hidden = true;
    const dropped = el('div', 'cut-dropped');
    dropped.hidden = true;
    view.append(frame, trim, empty, dropped);

    // scrub bar: the playhead, In/Out, click and drag to move
    const scrub = el('div', 'cut-scrub', undefined, { 'data-monitor': kind });
    const range = el('div', 'cut-scrub-range');
    const mark = el('div', 'cut-scrub-head');
    scrub.append(range, mark);

    const tc = ui.timecodeField({ fps: () => spec.fps(), value: 0, cls: 'cut-monitor-tc', title: tr('Playhead position'), onChange: (t) => seek(t) });
    const dur = el('span', 'cut-monitor-dur');
    const playBtn = button({ icon: 'play', title: tr('Play/Stop'), action: 'playPause', cls: 'cut-tr-play', onClick: () => run('playPause') });
    const loopBtn = button({ icon: 'loop', title: tr('Loop'), toggle: true, cls: 'cut-tr-loop', onClick: () => { loop = !loop; loopBtn.setPressed(loop); } });
    const safeBtn = button({ icon: 'safe', title: tr('Safe Margins'), toggle: true, pressed: !safe.hidden, cls: 'cut-tr-safe', onClick: () => {
      safe.hidden = !safe.hidden;
      safeBtn.setPressed(!safe.hidden);
      ide.settings.set(`cut.${kind}.safe`, !safe.hidden);
    } });
    const zoom = ui.select({ options: ZOOMS.map((z) => ({ value: z, label: z === 'fit' ? tr('Fit') : `${z}%` })), value: 'fit', cls: 'cut-monitor-zoom', title: tr('Zoom'),
      onChange: () => layout() });
    const quality = ui.select({ options: QUALITIES.map(([q, l]) => ({ value: q, label: tr(l) })), value: ide.settings.get(`cut.${kind}.quality`, 1), cls: 'cut-monitor-quality', title: tr('Playback Resolution'),
      onChange: (v) => { ide.settings.set(`cut.${kind}.quality`, Number(v)); m.player?.setQuality?.(Number(v)); } });
    const fsBtn = button({ icon: 'fullscreen', title: tr('Full Screen'), action: 'fullscreen', cls: 'cut-tr-fullscreen', onClick: () => fullscreen() });
    // Proxies: playback reads the small copies of the media that have one (export always reads the originals).
    const proxyBtn = button({ label: tr('Proxy'), title: tr('Play Proxies'), toggle: true, pressed: ide.settings.get('cut.proxy', false), cls: 'cut-tr-proxy', onClick: () => {
      const on = !proxyBtn.pressed;
      proxyBtn.setPressed(on);
      ide.settings.set('cut.proxy', on);
      m.player?.setProxy?.(on);
    } });
    // As in Premiere: the timecode, the zoom and resolution menus and the duration under the picture, then the time bar,
    // then the buttons.
    const info = el('div', 'cut-monitor-info');
    const left = el('div', 'cut-transport-side');
    left.append(tc);
    const tools = el('div', 'cut-monitor-tools');
    tools.append(zoom, quality, proxyBtn, safeBtn, fsBtn);
    const right = el('div', 'cut-transport-side right');
    right.append(dur);
    info.append(left, tools, right);
    const transport = el('div', 'cut-transport');
    const mid = el('div', 'cut-transport-mid');
    const extra = el('div', 'cut-transport-extra');
    const editorBtn = el('button', 'cut-btn icon-only cut-tr-editor', undefined, { type: 'button', title: tr('Button Editor'), 'aria-label': tr('Button Editor') });
    editorBtn.appendChild(glyph('editor'));
    editorBtn.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    editorBtn.addEventListener('click', () => buttonEditor(kind));
    transport.append(mid, extra, editorBtn);
    root.append(head, view, info, scrub, transport);
    // The bar's buttons, made once each; a button with a key shows it in its tooltip (it follows the keymap).
    const made = new Map([['playPause', playBtn], ['loop', loopBtn]]);
    playBtn.dataset.button = 'playPause';
    loopBtn.dataset.button = 'loop';
    const press = (id) => {
      if (['insert', 'overwrite', 'lift', 'extract', 'addMarker'].includes(id)) return ui.runAction(id, { source: 'button', panel: kind });
      if (id === 'exportFrame') return ui.exportDialog?.exportFrame(spec.app);
      return run(id);
    };
    function barButton(def) {
      if (made.has(def.id)) return made.get(def.id);
      const b = el('button', `cut-btn icon-only cut-tr-${def.id === 'playInToOut' ? 'inout' : def.id}`, undefined, { type: 'button', 'aria-label': tr(def.title), 'data-button': def.id });
      b.appendChild(glyph(def.glyph));
      ide.keymap.tooltip(b, tr(def.title), `Cut.${def.id}`);
      b.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      b.addEventListener('click', () => press(def.id));
      made.set(def.id, b);
      return b;
    }
    const buildBar = () => {
      const want = shownButtons(kind);
      mid.replaceChildren(...BUTTONS.filter((b) => want.includes(b.id)).map(barButton));
    };
    buildBar();

    let loop = false;
    let stopAt = null; // play In to Out ends here
    let shuttle = 0;
    const m = { el: root, view, frame, canvas, player: null, app: spec.app, fullscreen, setTitle: (t) => { title.textContent = t; }, extra, head, empty, wave };

    // Fits the picture in the view (or shows it at a zoom with scrollbars), keeping the frame's aspect.
    function layout() {
      const [w, h] = spec.size();
      const r = view.getBoundingClientRect();
      if (!r.width || !r.height || !w || !h) return;
      const z = zoom.value === 'fit' ? Math.min(r.width / w, r.height / h) : Number(zoom.value) / 100;
      frame.style.width = `${Math.max(1, Math.floor(w * z))}px`;
      frame.style.height = `${Math.max(1, Math.floor(h * z))}px`;
      view.classList.toggle('zoomed', zoom.value !== 'fit');
    }
    const ro = ide.util.observeSize(view, layout);

    // ---------- time ----------
    const frameLen = () => T().frameTicks(spec.fps());
    const end = () => Math.max(0, spec.duration());
    const lastFrame = () => Math.max(0, end() - frameLen());
    function seek(t) {
      const v = Math.max(0, Math.min(end(), Math.round(t)));
      spec.app.setTime(v);
      m.player?.seek?.(v);
    }
    function pause() { shuttle = 0; stopAt = null; m.player?.pause(); }
    function play(rate = 1) {
      if (!end()) return;
      if (rate > 0 && spec.app.t >= lastFrame()) seek(0);
      m.player?.play(rate);
    }
    function playInToOut() {
      const io = spec.inOut();
      const from = io.in ?? 0;
      seek(from);
      m.player?.play(1);
      stopAt = io.out ?? end();
    }
    // Up/Down: the edit points of the targeted tracks; Shift+Up/Down: of every track.
    const edits = (any = false) => {
      const pts = new Set([0, end()]);
      for (const c of spec.clips?.(any) || []) { pts.add(c.start); pts.add(Cut.model.clipEnd(c)); }
      return [...pts].sort((a, b) => a - b);
    };

    // ---------- actions ----------
    function run(id, ctx = {}) {
      const t = spec.app.t;
      const f = frameLen();
      const io = spec.inOut();
      switch (id) {
        case 'playPause': if (m.player?.playing) pause(); else play(1); break;
        case 'shuttleStop': pause(); break;
        case 'shuttleForward':
        case 'shuttleBack': {
          const dir = id === 'shuttleForward' ? 1 : -1;
          if (ctx.kHeld) { pause(); seek(t + dir * f); break; }
          const i = Math.sign(shuttle) === dir ? Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(Math.abs(shuttle)) + 1) : 0;
          shuttle = dir * SHUTTLE[i];
          stopAt = null;
          if (dir < 0 && t <= 0) { shuttle = 0; break; }
          m.player?.play(shuttle);
          break;
        }
        case 'frameBack': pause(); seek(t - f); break;
        case 'frameForward': pause(); seek(t + f); break;
        case 'frameBack5': pause(); seek(t - 5 * f); break;
        case 'frameForward5': pause(); seek(t + 5 * f); break;
        case 'goStart': pause(); seek(0); break;
        case 'goEnd': pause(); seek(end()); break;
        case 'prevEdit': case 'prevEditAny': { pause(); const p = edits(id === 'prevEditAny').filter((x) => x < t).pop(); seek(p ?? 0); break; }
        case 'nextEdit': case 'nextEditAny': { pause(); const p = edits(id === 'nextEditAny').find((x) => x > t); seek(p ?? end()); break; }
        case 'prevMarker': case 'nextMarker': {
          const list = (spec.markers?.() || []).sort((a, b) => a - b);
          const p = id === 'prevMarker' ? list.filter((x) => x < t).pop() : list.find((x) => x > t);
          if (p != null) { pause(); seek(p); }
          break;
        }
        case 'playInToOut': playInToOut(); break;
        case 'goIn': if (io.in != null) { pause(); seek(io.in); } break;
        case 'goOut': if (io.out != null) { pause(); seek(io.out - f); } break;
        case 'markIn': spec.setInOut({ in: t, out: io.out != null && io.out <= t ? null : io.out }); break;
        case 'markOut': spec.setInOut({ out: Math.min(end(), t + f), in: io.in != null && io.in > t ? null : io.in }); break;
        case 'markClip': {
          const c = spec.markClip?.();
          if (c) spec.setInOut(c);
          else spec.setInOut({ in: 0, out: end() });
          break;
        }
        case 'clearInOut': spec.setInOut({ in: null, out: null }); break;
        case 'clearIn': spec.setInOut({ in: null }); break;
        case 'clearOut': spec.setInOut({ out: null }); break;
        case 'fullscreen': fullscreen(); break;
        default: return false;
      }
      return true;
    }
    function fullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      view.requestFullscreen?.().catch((err) => log.warn(`full screen: ${err?.message || err}`));
    }

    // ---------- drawing the controls ----------
    let raf = 0;
    const refresh = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const total = end();
        const t = spec.app.t;
        tc.value = t;
        const io = spec.inOut();
        const pct = (x) => `${total ? Math.min(100, (x / total) * 100) : 0}%`;
        mark.style.left = pct(t);
        range.hidden = io.in == null && io.out == null;
        range.style.left = pct(io.in ?? 0);
        range.style.right = `calc(100% - ${pct(io.out ?? total)})`;
        scrub.dataset.in = io.in ?? '';
        scrub.dataset.out = io.out ?? '';
        const len = io.in != null || io.out != null ? (io.out ?? total) - (io.in ?? 0) : total;
        dur.textContent = T().timecode(Math.max(0, len), spec.fps());
        dur.title = io.in != null || io.out != null ? tr('In to Out duration') : tr('Duration');
        const playing = !!m.player?.playing;
        // Only on a change: a new icon under a press made the release land on another element, so no click came and
        // the button could not stop playback.
        if (playBtn.classList.contains('playing') !== playing || !playBtn.firstChild) playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
        playBtn.classList.toggle('playing', playing);
        root.classList.toggle('playing', playing);
        const n = m.player?.dropped || 0;
        dropped.hidden = !n;
        dropped.textContent = tr('{n} dropped frames', { n });
      });
    };
    // Playback ends at the end (or at the Out of Play In to Out), or starts over there when Loop is on.
    const onTime = ({ t }) => {
      const p = m.player;
      if (p?.playing) {
        const from = stopAt != null ? spec.inOut().in ?? 0 : 0;
        const limit = stopAt ?? end();
        const over = p.rate > 0 ? t >= limit - frameLen() / 2 : t <= from;
        if (over && loop) seek(p.rate > 0 ? from : limit - frameLen());
        else if (over) { const at = p.rate > 0 ? limit - frameLen() : from; pause(); seek(at); }
      }
      refresh();
    };

    // scrub bar dragging
    scrub.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      scrub.setPointerCapture(e.pointerId);
      pause();
      const at = (ev) => {
        const r = scrub.getBoundingClientRect();
        seek(((ev.clientX - r.left) / r.width) * end());
      };
      at(e);
      const move = (ev) => at(ev);
      const up = () => { scrub.removeEventListener('pointermove', move); scrub.removeEventListener('pointerup', up); };
      scrub.addEventListener('pointermove', move);
      scrub.addEventListener('pointerup', up);
    });
    // the wheel steps frames, as in other editors
    view.addEventListener('wheel', (e) => {
      if (e.ctrlKey || !end()) return;
      e.preventDefault();
      pause();
      seek(spec.app.t + Math.sign(e.deltaY) * frameLen());
    }, { passive: false });

    m.start = () => {
      m.player = makePlayer(spec.app, canvas);
      m.player?.setQuality?.(Number(quality.value) || 1);
      m.player?.setProxy?.(proxyBtn.pressed);
      root.dataset.engine = m.player?.fallback ? 'none' : 'player';
      layout();
      refresh();
    };
    m.run = run;
    m.refresh = refresh;
    m.layout = layout;
    m.pause = pause;
    m.seek = seek;
    m.onTime = onTime;
    // The settings page (ui-settings.js) changes the playback quality and the proxy switch: the monitor follows.
    const offSettings = ide.on('settingsChanged', (k) => {
      if (k === `cut.${kind}.quality`) {
        const q = Number(ide.settings.get(k, 1)) || 1;
        if (Number(quality.value) !== q) { quality.value = String(q); m.player?.setQuality?.(q); }
      } else if (k === buttonsKey(kind)) {
        buildBar();
      } else if (k === `cut.${kind}.safe`) {
        const on = !!ide.settings.get(k, false);
        if (safe.hidden === on) { safe.hidden = !on; safeBtn.setPressed(on); }
      } else if (k === 'cut.proxy') {
        const on = !!ide.settings.get('cut.proxy', false);
        if (proxyBtn.pressed !== on) { proxyBtn.setPressed(on); m.player?.setProxy?.(on); }
      }
    });
    m.proxyButton = proxyBtn;
    m.qualitySelect = quality;
    m.dispose = () => {
      offSettings?.();
      ro.disconnect();
      cancelAnimationFrame(raf);
      try { m.player?.destroy?.(); } catch {}
    };
    return m;
  }

  // ---------- the program monitor ----------
  function mountProgram(root, app) {
    const m = monitor(root, {
      kind: 'program',
      app,
      size: () => [app.sequence?.w || 1920, app.sequence?.h || 1080],
      fps: () => app.sequence?.fps || [30, 1],
      duration: () => (app.sequence ? Cut.model.sequenceDuration(app.sequence) : 0),
      inOut: () => app.inOut,
      setInOut: (p) => app.setInOut(p),
      // the clips of the targeted tracks (every track with `any`)
      clips: (any) => {
        const ids = !any && ui.editing.targets;
        return (app.sequence?.clips || []).filter((c) => !ids || ids.includes(c.track));
      },
      markers: () => (app.sequence?.markers || []).map((mk) => mk.t),
      // X: the selected clip under the playhead, else the top clip there.
      markClip: () => {
        const seq = app.sequence;
        if (!seq) return null;
        const under = Cut.model.clipsAt(seq, app.t, {});
        const c = under.find((x) => app.selection.has(x.id)) || under.filter((x) => seq.tracks.find((t) => t.id === x.track)?.kind === 'video').pop() || under[0];
        return c ? { in: c.start, out: Cut.model.clipEnd(c) } : null;
      },
    });
    m.setTitle(app.sequence?.name || tr('Program'));
    m.start();
    const offs = [
      app.on('time', m.onTime),
      app.on('playing', m.refresh),
      app.on('inout', m.refresh),
      app.on('project', () => { m.setTitle(app.sequence?.name || ''); m.layout(); m.refresh(); }),
      app.on('sequence', () => { m.pause(); m.setTitle(app.sequence?.name || ''); m.layout(); m.refresh(); }),
    ];
    for (const id of ['playPause', 'shuttleBack', 'shuttleStop', 'shuttleForward', 'frameBack', 'frameForward', 'frameBack5', 'frameForward5',
      'prevEdit', 'nextEdit', 'prevEditAny', 'nextEditAny', 'prevMarker', 'nextMarker', 'goStart', 'goEnd', 'goIn', 'goOut', 'markIn', 'markOut',
      'markClip', 'clearIn', 'clearOut', 'clearInOut', 'playInToOut', 'fullscreen']) {
      offs.push(ui.onAction(id, (ctx) => m.run(id, ctx), { panels: PROGRAM_PANELS }));
    }
    // Two frames side by side while the timeline trims an edit point: the outgoing clip's last and the incoming first.
    let trimComps = null;
    m.showTrim = async (spec) => {
      const tv = root.querySelector('.cut-trim-view');
      // the sequence times the two frames show (null while hidden)
      m.trimTimes = spec ? { left: spec.left, right: spec.right } : null;
      if (!spec) { tv.hidden = true; m.frame.hidden = false; return; }
      if (!Cut.compositor?.create || !app.sequence) return;
      tv.hidden = false;
      m.frame.hidden = true;
      if (!trimComps) {
        const make = async (cls) => {
          const c = el('canvas', `cut-trim-canvas ${cls}`);
          c.width = Math.max(2, Math.round(app.sequence.w / 4));
          c.height = Math.max(2, Math.round(app.sequence.h / 4));
          tv.appendChild(c);
          return { canvas: c, comp: await Cut.compositor.create(c, { width: c.width, height: c.height }) };
        };
        trimComps = [await make('left'), await make('right')];
      }
      const [a, b] = trimComps;
      await Promise.all([
        spec.left != null && a.comp.render(app.project, app.sequenceId, spec.left, { quality: 0.25 }),
        spec.right != null && b.comp.render(app.project, app.sequenceId, spec.right, { quality: 0.25 }),
      ]).catch((err) => log.warn(`trim view: ${err?.message || err}`));
    };
    // The pixels of the two frames ([{px, w, h}] left and right; null before the view was first shown).
    m.readTrim = async () => (trimComps ? Promise.all(trimComps.map(async ({ canvas, comp }) => ({ px: await comp.readPixels(), w: canvas.width, h: canvas.height }))) : null);
    monitors.program = m;
    // The program monitor's on-canvas handles (ui-overlay.js), when that file is there.
    let overlay = null;
    try { overlay = Cut.ui.overlay?.attach?.(m.view, app, m.player) || null; } catch (err) { log.warn(`overlay: ${err?.message || err}`); }
    return {
      dispose: () => { for (const off of offs) off(); try { overlay?.detach?.(); } catch {} m.dispose(); if (monitors.program === m) monitors.program = null; },
    };
  }

  // ---------- the source monitor ----------
  const evenSize = (n) => Math.max(2, n - (n % 2));
  const rateOf = (fps) => (fps && Cut.model.validFps(fps) ? fps : T().FRAME_RATES.reduce((best, r) => (fps && Math.abs(r[0] / r[1] - fps[0] / fps[1]) < Math.abs(best[0] / best[1] - fps[0] / fps[1]) ? r : best), [30, 1]));
  // A project with the one media file on a sequence of its size and rate, the clip from 0 to its end.
  function sourceHistory(media, editorProject) {
    const v = media.video;
    const rotated = v && (v.rotation === 90 || v.rotation === 270);
    const w = v?.w ? evenSize(rotated ? v.h : v.w) : 1920;
    const h = v?.h ? evenSize(rotated ? v.w : v.h) : 1080;
    const project = Cut.model.createProject({ sequence: { w, h, fps: rateOf(v?.fps), videoTracks: 1, audioTracks: 1, name: media.name } });
    project.settings = { ...project.settings, ...(editorProject?.settings || {}) };
    project.media.push(JSON.parse(JSON.stringify(media)));
    const n = Number(/\d+$/.exec(media.id)?.[0] || 0);
    project.nextId = Math.max(project.nextId, n + 1);
    const history = Cut.commands.createHistory(project);
    const seq = project.sequences[0];
    const vt = seq.tracks.find((t) => t.kind === 'video').id;
    const at = seq.tracks.find((t) => t.kind === 'audio').id;
    history.do(Cut.commands.place(seq.id, { source: { media: media.id }, at: 0, video: media.kind === 'audio' ? null : vt, audio: media.audio ? at : null, mode: 'overwrite' }));
    return history;
  }

  // A sequence in the source monitor (Premiere's Open in Source Monitor): a copy of the editor's project whose first
  // sequence holds one nest clip of it at its own size and rate, so Insert and Overwrite place a nest clip.
  function sequenceHistory(seqId, editorProject) {
    const project = JSON.parse(JSON.stringify(editorProject));
    const seq = project.sequences.find((x) => x.id === seqId);
    const id = `s${project.nextId}`;
    project.nextId += 1;
    project.sequences.unshift(Cut.model.createSequence({ id, w: seq.w, h: seq.h, fps: seq.fps, videoTracks: 1, audioTracks: 1, name: seq.name }));
    const history = Cut.commands.createHistory(project);
    const has = Cut.model.nestKinds(project, seqId);
    if (has.video || has.audio) history.do(Cut.commands.place(id, { source: { sequence: seqId }, at: 0, video: has.video ? 'V1' : null, audio: has.audio ? 'A1' : null, mode: 'overwrite' }));
    return history;
  }

  function mountSource(root, app) {
    const own = Cut.state.createApp();
    let media = null;
    const src = () => app.source;
    const m = monitor(root, {
      kind: 'source',
      app: own,
      size: () => [own.sequence?.w || 1920, own.sequence?.h || 1080],
      fps: () => own.sequence?.fps || [30, 1],
      duration: () => (own.sequence ? Cut.model.sequenceDuration(own.sequence) : 0),
      inOut: () => ({ in: src()?.in ?? null, out: src()?.out ?? null }),
      setInOut: (p) => { if (src()) app.setSource({ ...src(), ...p }); },
    });
    // the sequence shown instead of a media file, or null
    let shownSeq = null;
    const has = () => (shownSeq ? Cut.model.nestKinds(app.project, shownSeq.id) : { video: !!media && media.kind !== 'audio', audio: !!media?.audio });
    // Insert and Overwrite, and the handles that drag the clip (or only its video or audio) to the timeline.
    const dragV = el('span', 'cut-drag-handle video', undefined, { title: tr('Drag Video Only') });
    dragV.appendChild(icon('video'));
    const dragA = el('span', 'cut-drag-handle audio', undefined, { title: tr('Drag Audio Only') });
    dragA.appendChild(icon('audio'));
    m.extra.append(dragV, dragA);
    const payload = (video, audio) => {
      const s = src();
      const total = Cut.model.sequenceDuration(own.sequence);
      if (shownSeq) return { kind: 'source', sequenceId: shownSeq.id, in: s.in ?? 0, out: s.out ?? total, video: video && has().video, audio: audio && has().audio };
      return { kind: 'source', mediaId: s.mediaId, in: s.in ?? 0, out: s.out ?? (media?.kind === 'image' ? null : total), video: video && media?.kind !== 'audio', audio: audio && !!media?.audio };
    };
    const startDrag = (e, video, audio) => {
      if (!src() || (!media && !shownSeq)) return;
      e.preventDefault();
      ui.dnd.start(e, payload(video, audio), { label: shownSeq ? shownSeq.name : media.name });
    };
    m.frame.addEventListener('pointerdown', (e) => startDrag(e, true, true));
    dragV.addEventListener('pointerdown', (e) => startDrag(e, true, false));
    dragA.addEventListener('pointerdown', (e) => startDrag(e, false, true));
    // the clip list: what was opened in the source monitor, newest first
    const recent = [];
    const pick = button({ icon: 'chevronDown', title: tr('Recent Clips'), cls: 'cut-source-recent', onClick: () => {
      const items = recent.map((id) => app.project?.media.find((x) => x.id === id)).filter(Boolean)
        .map((x) => ({ label: x.name, userText: true, checked: x.id === src()?.mediaId, run: () => app.setSource({ mediaId: x.id, in: null, out: null, t: 0 }) }));
      if (items.length) ui.menu(pick, items);
    } });
    m.head.appendChild(pick);

    function show() {
      const s = src();
      const nextSeq = s?.sequenceId != null ? app.project?.sequences.find((x) => x.id === s.sequenceId) || null : null;
      if (nextSeq) {
        // Rebuilt on every change of the editor's project: the copy shows that sequence as it is now.
        const changed = shownSeq?.id !== nextSeq.id;
        const keep = changed ? (s.t || 0) : own.t;
        media = null;
        shownSeq = nextSeq;
        root.classList.remove('no-source');
        m.empty.hidden = true;
        m.wave.hidden = true;
        if (changed) m.pause();
        try { own.setHistory(sequenceHistory(nextSeq.id, app.project), null, 'open'); } catch (err) { ui.report(err); return; }
        m.setTitle(nextSeq.name);
        if (keep) m.seek(keep);
        m.layout();
        m.refresh();
        return;
      }
      shownSeq = null;
      const next = s ? app.project?.media.find((x) => x.id === s.mediaId) : null;
      if (!next) {
        media = null;
        m.pause();
        own.setHistory(Cut.commands.createHistory(Cut.model.createProject({ sequence: { name: '' } })), null, 'new');
        m.setTitle(tr('Source'));
        m.empty.textContent = tr('Double-click a clip in the project to open it here.');
        m.empty.hidden = false;
        root.classList.add('no-source');
        m.refresh();
        return;
      }
      const changed = media?.id !== next.id || media?.path !== next.path;
      media = next;
      root.classList.remove('no-source');
      m.empty.hidden = true;
      if (changed) {
        m.pause();
        try { own.setHistory(sourceHistory(next, app.project), null, 'open'); } catch (err) { ui.report(err); return; }
        recent.splice(0, Infinity, next.id, ...recent.filter((id) => id !== next.id).slice(0, 9));
        m.setTitle(next.name);
        if (s.t) m.seek(s.t);
        drawWave();
      }
      m.layout();
      m.refresh();
    }
    // Audio files have no picture: their waveform takes the monitor.
    async function drawWave() {
      m.wave.hidden = media?.kind !== 'audio';
      if (media?.kind !== 'audio' || !Cut.thumbs?.peaks) return;
      const id = media.id;
      const peaks = await Cut.thumbs.peaks(app.project, id, { samplesPerPeak: 1024 }).catch(() => null);
      if (!peaks || media?.id !== id) return;
      const c = m.wave;
      c.width = 960;
      c.height = 540;
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = getComputedStyle(root).getPropertyValue('--cut-wave').trim() || '#3fae8c';
      const n = peaks.length / 2;
      for (let x = 0; x < c.width; x++) {
        const i = Math.floor((x / c.width) * n) * 2;
        const lo = peaks[i] ?? 0;
        const hi = peaks[i + 1] ?? 0;
        g.fillRect(x, (1 - hi) * c.height / 2, 1, Math.max(1, (hi - lo) * c.height / 2));
      }
    }

    // Insert (',') or Overwrite ('.'): the source In/Out (or all of it) at the sequence In, or at the playhead.
    async function place(mode) {
      const s = src();
      const seq = app.sequence;
      if (!s || (!media && !shownSeq) || !seq) { ui.toast(tr('Open a clip in the source monitor first.')); return; }
      if (media) await ui.media.matchSequence(app, media.id);
      const patch = ui.patchFor(app);
      const total = Cut.model.sequenceDuration(own.sequence);
      const opts = {
        source: shownSeq ? { sequence: shownSeq.id } : { media: media.id },
        in: s.in ?? 0,
        out: s.out ?? total,
        video: has().video ? patch.video : null,
        audio: has().audio ? patch.audio : null,
        mode,
      };
      if (opts.video == null && opts.audio == null) { ui.toast(tr('Choose a target track.')); return; }
      const io = app.inOut;
      const cmd = io.in != null || io.out != null
        ? Cut.commands.placeRange(seq.id, { ...opts, range: { in: io.in, out: io.out } })
        : Cut.commands.place(seq.id, { ...opts, at: app.t });
      const r = ui.exec(app, cmd);
      if (!r) return;
      app.select(r.ids || []);
      app.setInOut({ in: null, out: null });
      monitors.program?.pause();
      app.setTime(r.at + r.duration);
    }

    m.start();
    const offs = [
      own.on('time', (e) => { m.onTime(e); if (src()) src().t = e.t; }),
      own.on('playing', m.refresh),
      app.on('source', show),
      app.on('project', ({ reason }) => {
        if (reason === 'open' || reason === 'new' || reason === 'recover') { app.setSource(null); return; }
        const s = src();
        const there = s && (s.sequenceId != null ? app.project.sequences.some((x) => x.id === s.sequenceId) : app.project.media.some((x) => x.id === s.mediaId));
        if (s && !there) app.setSource(null);
        else if (s) show();
      }),
    ];
    for (const id of ['playPause', 'shuttleBack', 'shuttleStop', 'shuttleForward', 'frameBack', 'frameForward', 'frameBack5', 'frameForward5',
      'goStart', 'goEnd', 'goIn', 'goOut', 'markIn', 'markOut', 'markClip', 'clearIn', 'clearOut', 'clearInOut', 'playInToOut', 'fullscreen', 'prevEdit', 'nextEdit']) {
      offs.push(ui.onAction(id, (ctx) => m.run(id, ctx), { panels: ['source'] }));
    }
    // Insert and Overwrite work from the source monitor and from the timeline, as long as a clip is open here.
    for (const mode of ['insert', 'overwrite']) {
      offs.push(ui.onAction(mode, () => { if (!src()) return false; place(mode); }, { panels: ['source', 'timeline', 'program'] }));
    }
    show();
    m.place = place;
    monitors.source = m;
    return { dispose: () => { for (const off of offs) off(); m.dispose(); if (monitors.source === m) monitors.source = null; } };
  }

  const monitors = { source: null, program: null };
  ui.monitors = monitors;
  ui.registerPanel('source', { title: () => tr('Source'), mount: mountSource });
  ui.registerPanel('program', { title: () => tr('Program'), mount: mountProgram });
})();
