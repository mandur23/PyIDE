// The player of Nano Studio Cut's monitors (docs/cut-architecture.md section 8): draws the active sequence (or, in
// source mode, the clip in the source monitor) into a canvas through a compositor, again whenever the time, the
// project or the sequence changes; plays at a shuttle rate (J/K/L: -8..8) following the audio engine's clock when
// there is one and the rate is 1, else performance.now(); moves the playhead (app.setTime) frame by frame; decodes
// ahead of the playhead; counts the frames it could not show in time (dropped).
//
// Stopped, it draws at full quality; playing, at `quality` (1, 1/2, 1/4). Renders never overlap: a request that comes
// while one runs is drawn after it, with the newest time.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).player = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = need('time');

  const RATES = [-8, -4, -2, -1, -0.5, 0.5, 1, 2, 4, 8];
  const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(performance.now()), 16));
  const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

  // How many frames a step of the playhead skipped beyond what the rate itself skips.
  function droppedBetween(prev, next, rate) {
    if (prev == null) return 0;
    const step = Math.abs(next - prev);
    return Math.max(0, step - Math.max(1, Math.ceil(Math.abs(rate))));
  }

  // opts: { app, canvas, audio (a Cut.audioengine instance or null), mode: 'program' | 'source', backend, hardware,
  // captions (burn in: true | trackId, or a function giving one, asked at each draw; the app's 'captionTrack' draws
  // again), overlays, proxy }
  function create(opts = {}) {
    const { app, canvas } = opts;
    const audio = opts.audio || null;
    const mode = opts.mode === 'source' ? 'source' : 'program';
    let comp = null;
    let destroyed = false;
    let playing = false;
    let rate = 1;
    let quality = 1;
    let dropped = 0;
    let shown = 0;
    let lastFrame = null; // the frame last sent to be drawn
    let lastSet = null; // the time the playhead was last moved to
    let clock = null; // { t0, wall0, rate, audio: boolean, heard, heardAt }
    let loop = null;
    let busy = false;
    let want = null; // { t, q } waiting for the render in progress
    let paint = null;
    let lastPrefetch = -Infinity;
    let playStart = 0;
    let shownSincePlay = 0;
    const renderTimes = [];
    const offs = [];
    const listeners = new Set();
    const emit = (what) => { for (const fn of [...listeners]) { try { fn(what); } catch {} } };

    const project = () => app.project;
    const sequence = () => (mode === 'program' ? app.sequence : null);
    const mediaOf = () => (mode === 'source' && app.source?.mediaId != null ? app.project?.media.find((m) => m.id === app.source.mediaId) || null : null);
    const fps = () => (mode === 'program' ? sequence()?.fps : mediaOf()?.video?.fps) || [30, 1];
    const now = () => (mode === 'program' ? app.t : app.source?.t || 0);
    const duration = () => {
      if (mode === 'program') { const s = sequence(); return s ? need('model').sequenceDuration(s) : 0; }
      const m = mediaOf();
      return m ? (m.kind === 'image' ? need('model').defaultSettings().stillDuration : m.duration) : 0;
    };
    const setNow = (t) => {
      if (mode === 'program') app.setTime(t);
      else if (app.source) app.setSource({ ...app.source, t });
    };

    // The canvas's drawing size: its shown size in device pixels when it is on screen, else the sequence's size.
    function fitCanvas() {
      if (!comp) return;
      const seq = sequence();
      let w = seq?.w || mediaOf()?.video?.w || 1920;
      let h = seq?.h || mediaOf()?.video?.h || 1080;
      if (canvas?.isConnected && canvas.clientWidth > 0 && canvas.clientHeight > 0 && opts.size !== 'sequence') {
        const dpr = globalThis.devicePixelRatio || 1;
        w = Math.round(canvas.clientWidth * dpr);
        h = Math.round(canvas.clientHeight * dpr);
      }
      if (w !== comp.width || h !== comp.height) comp.resize(w, h);
    }

    async function draw(t, q) {
      const p = project();
      if (!comp || !p) return;
      fitCanvas();
      const t0 = performance.now();
      const ropts = { quality: q, captions: typeof opts.captions === 'function' ? opts.captions() : opts.captions, overlays: opts.overlays, proxy: player.proxy };
      if (mode === 'program') {
        const seq = sequence();
        if (!seq) return;
        await comp.render(p, seq.id, t, ropts);
      } else {
        const m = mediaOf();
        if (!m) return;
        await comp.renderMedia(p, m.id, t, ropts);
      }
      const ms = performance.now() - t0;
      renderTimes.push(ms);
      if (renderTimes.length > 60) renderTimes.shift();
      shown++;
      emit({ type: 'frame', t, ms });
    }
    // Draws t now if nothing is drawing, else right after (only the newest request is kept).
    function request(t, q) {
      if (destroyed) return Promise.resolve();
      if (busy) {
        want = { t, q };
        return paint || Promise.resolve();
      }
      busy = true;
      paint = (async () => {
        let next = { t, q };
        while (next && !destroyed) {
          want = null;
          try { await draw(next.t, next.q); } catch (err) { emit({ type: 'error', error: err }); }
          next = want;
        }
        busy = false;
      })();
      return paint;
    }
    // Stopped: one full-quality draw per animation frame, of the latest state.
    let pending = false;
    function redraw() {
      if (playing || pending || destroyed) return;
      pending = true;
      raf(() => {
        pending = false;
        if (!playing) request(now(), 1);
      });
    }

    // An audio clock that stands still this long has stopped (no output device, or it never started): the picture goes
    // on by the wall clock from there. Starting waits up to 1.5 s for the first seconds' sound.
    const AUDIO_STALL_MS = 2500;
    function clockNow() {
      if (clock.audio) {
        const v = audio.now();
        const wall = performance.now();
        if (v !== clock.heard) { clock.heard = v; clock.heardAt = wall; return v; }
        if (wall - clock.heardAt < AUDIO_STALL_MS) return v;
        try { audio.stop(); } catch {}
        clock = { t0: v, wall0: wall, rate: clock.rate, audio: false };
      }
      return clock.t0 + ((performance.now() - clock.wall0) / 1000) * clock.rate * time.TICKS;
    }
    function startClock(t) {
      const useAudio = !!audio && mode === 'program' && rate === 1;
      clock = { t0: t, wall0: performance.now(), rate, audio: useAudio, heard: t, heardAt: performance.now() };
      if (useAudio) {
        try { Promise.resolve(audio.start(t)).catch(() => { if (clock?.audio) clock = { t0: t, wall0: performance.now(), rate, audio: false }; }); } catch { clock.audio = false; }
      }
    }
    function stopClock() {
      if (clock?.audio) { try { audio.stop(); } catch {} }
      clock = null;
    }

    function tick() {
      loop = null;
      if (!playing || destroyed) return;
      const f = fps();
      const ft = time.frameTicks(f);
      const end = duration();
      let t = clockNow();
      let stop = false;
      if (rate > 0 && t >= end - ft / 2) { t = Math.max(0, end - ft); stop = true; }
      if (rate < 0 && t <= 0) { t = 0; stop = true; }
      const frame = time.frameAt(Math.max(0, t), f);
      const ts = time.frameStart(frame, f);
      // The playhead keeps the clock's time even while a slow frame is still being drawn; the picture catches up.
      if (ts !== lastSet) { lastSet = ts; setNow(ts); }
      if (!busy && frame !== lastFrame) {
        dropped += droppedBetween(lastFrame, frame, rate);
        lastFrame = frame;
        shownSincePlay++;
        request(ts, quality);
        if (Math.abs(ts - lastPrefetch) > time.TICKS / 2 && mode === 'program' && comp) {
          lastPrefetch = ts;
          const seq = sequence();
          if (seq) comp.prefetch(project(), seq.id, ts, ts + 2 * time.TICKS * Math.sign(rate) * Math.max(1, Math.abs(rate)), { proxy: player.proxy });
        }
      }
      if (stop) { player.pause(); return; }
      loop = raf(tick);
    }

    const player = {
      proxy: !!opts.proxy,
      ready: null,
      get compositor() { return comp; },
      // the audio engine heard while playing (the meters read it), or null
      get audio() { return audio; },
      get playing() { return playing; },
      get rate() { return rate; },
      get quality() { return quality; },
      get dropped() { return dropped; },
      setQuality(q) {
        quality = [1, 0.5, 0.25].includes(q) ? q : 1;
        if (!playing) redraw();
      },
      setProxy(on) {
        player.proxy = !!on;
        redraw();
      },
      // rate: 1 plays, 2/4/8 fast forward, negative backwards; 0 stops.
      play(r = 1) {
        if (destroyed) return;
        const v = Number(r) || 0;
        if (!v) return void player.pause();
        rate = Math.max(-8, Math.min(8, v));
        const end = duration();
        let t = now();
        if (rate > 0 && t >= end - time.frameTicks(fps())) t = 0;
        stopClock();
        dropped = 0;
        lastFrame = null;
        lastSet = t;
        shownSincePlay = 0;
        playStart = performance.now();
        lastPrefetch = -Infinity;
        playing = true;
        if (t !== now()) setNow(t);
        startClock(t);
        if (mode === 'program') app.setPlaying(true);
        globalThis.Cut?.thumbs?.pause?.(true);
        emit({ type: 'play', rate });
        if (!loop) loop = raf(tick);
      },
      pause() {
        if (!playing) return;
        playing = false;
        stopClock();
        if (loop != null) { caf(loop); loop = null; }
        if (mode === 'program') app.setPlaying(false);
        globalThis.Cut?.thumbs?.pause?.(false);
        emit({ type: 'pause' });
        redraw();
      },
      seek(t) {
        const v = Math.max(0, Math.min(Math.round(t), Math.max(0, duration())));
        lastSet = v;
        setNow(v);
        if (playing) {
          stopClock();
          lastFrame = null;
          startClock(v);
        } else redraw();
      },
      // Draws the current time now (full quality) and resolves when it is on the canvas.
      render: () => request(now(), playing ? quality : 1),
      // Where the frame is drawn in the canvas, in CSS pixels: { x, y, w, h, scale } (scale: CSS px per sequence px).
      frameRect() {
        const seq = sequence();
        const w = seq?.w || mediaOf()?.video?.w || 1920;
        const h = seq?.h || mediaOf()?.video?.h || 1080;
        const cw = canvas?.clientWidth || comp?.width || w;
        const ch = canvas?.clientHeight || comp?.height || h;
        const s = Math.min(cw / w, ch / h);
        return { x: (cw - w * s) / 2, y: (ch - h * s) / 2, w: w * s, h: h * s, scale: s };
      },
      stats() {
        const secs = (performance.now() - playStart) / 1000;
        const avg = renderTimes.length ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length : 0;
        return { shown, dropped, fps: playing && secs > 0 ? shownSincePlay / secs : 0, renderMs: avg, renderMaxMs: Math.max(0, ...renderTimes), backend: comp?.backend || null };
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      destroy() {
        if (destroyed) return;
        player.pause();
        destroyed = true;
        for (const off of offs) off();
        comp?.destroy();
      },
    };

    player.ready = need('compositor').create(canvas, { backend: opts.backend, hardware: opts.hardware, width: canvas?.width, height: canvas?.height }).then((c) => {
      if (destroyed) { c.destroy(); return c; }
      comp = c;
      redraw();
      return c;
    });
    // Our own setTime while playing comes back as a 'time' event; only outside changes ask for a draw.
    const onTime = () => { if (!playing) redraw(); else if (clock && Math.abs(now() - (lastSet ?? 0)) > time.frameTicks(fps())) player.seek(now()); };
    if (app?.on) {
      if (mode === 'program') {
        offs.push(app.on('time', onTime));
        offs.push(app.on('sequence', () => { if (playing) player.pause(); redraw(); }));
        offs.push(app.on('captionTrack', () => { if (!playing) redraw(); }));
      } else {
        offs.push(app.on('source', () => { if (!playing) redraw(); }));
      }
      offs.push(app.on('project', () => { if (!playing) redraw(); }));
    }
    // A canvas shown at a new size (window or panel resized, or moved to a screen of another scale) is drawn again
    // at that size; stopped, nothing else would, and the old frame stayed stretched and blurred.
    if (canvas && typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => redraw());
      try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }
      offs.push(() => ro.disconnect());
    }
    return player;
  }

  return { create, RATES, droppedBetween };
});
