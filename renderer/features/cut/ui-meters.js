// The audio meters panel (video-editor-features.md section 12): the master output's level while the program plays,
// read from the audio engine (Cut.audioengine meters(): the peak and the RMS of the block being heard, per channel).
// Each channel is a bar on a dB scale from -60 to 0: the RMS solid, the peak lighter above it, a peak-hold line that
// stays 1.5 s and then falls, and a clip light above the bar that stays on after the level reached 0 dBFS until it is
// clicked. A dashed line marks -1 dBTP, the ceiling the export presets aim under.
//
// It draws on one canvas from requestAnimationFrame only while the program plays or a level is still falling, and
// not at all while the panel is out of view, so it costs playback nothing measurable (verify/cut-panels.mjs).
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { el } = ui;
  const FLOOR = -60;
  const CEILING = -1; // dBTP line
  const HOLD_MS = 1500;
  const HOLD_FALL = 20; // dB a second once the hold ran out
  const BAR_FALL = 30; // dB a second: the bars fall smoothly, they rise at once
  const TICKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60];

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-meters');
    const clips = el('div', 'cut-meters-clips');
    const clipBtn = [0, 1].map((ch) => {
      const b = el('button', 'cut-meter-clip', undefined, { type: 'button', 'data-ch': String(ch), title: tr('Clipped: click to reset'), 'aria-label': tr('Clip indicator') });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => reset());
      return b;
    });
    clips.append(...clipBtn);
    const box = el('div', 'cut-meters-box');
    const canvas = el('canvas', 'cut-meters-canvas');
    box.appendChild(canvas);
    const readout = el('div', 'cut-meters-readout');
    const read = [0, 1].map(() => el('span', 'cut-meter-value', '-∞'));
    readout.append(...read);
    root.append(clips, box, readout);
    host.appendChild(root);

    // per channel, in dBFS
    const st = { peak: [-Infinity, -Infinity], rms: [-Infinity, -Infinity], hold: [-Infinity, -Infinity], holdAt: [0, 0], max: [-Infinity, -Infinity], clip: [false, false] };
    let colors = null;
    const readColors = () => {
      const cs = getComputedStyle(root);
      const v = (n, fb) => cs.getPropertyValue(n).trim() || fb;
      colors = { low: v('--cut-meter-low', '#3fae5a'), mid: v('--cut-meter-mid', '#e6c84a'), high: v('--cut-meter-high', '#e05555'),
        bg: v('--cut-meter-bg', '#15161a'), text: v('--gray8', '#868a91'), tick: v('--gray5', '#55585e'), hold: v('--gray12', '#eeeeee') };
    };

    function reset() {
      st.clip = [false, false];
      st.max = [-Infinity, -Infinity];
      for (const b of clipBtn) b.classList.remove('on');
      for (const r of read) r.textContent = '-∞';
      draw();
    }

    // geometry of the canvas in CSS pixels: the scale on the left, two bars
    function layout() {
      const w = box.clientWidth;
      const h = box.clientHeight;
      const scaleW = Math.min(24, Math.max(16, w * 0.32));
      const gap = 3;
      const barW = Math.max(4, (w - scaleW - gap * 3) / 2);
      const top = 6;
      const bottom = h - 6;
      const yOf = (db) => top + ((0 - Math.max(FLOOR, Math.min(0, db))) / -FLOOR) * (bottom - top);
      return { w, h, scaleW, top, bottom, bars: [0, 1].map((i) => ({ x: scaleW + gap + i * (barW + gap), w: barW })), yOf };
    }

    function draw() {
      if (!box.isConnected || !box.clientWidth || !box.clientHeight) return false;
      if (!colors) readColors();
      const g = layout();
      const dpr = devicePixelRatio || 1;
      const W = Math.round(g.w * dpr);
      const H = Math.round(g.h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = `${g.w}px`;
        canvas.style.height = `${g.h}px`;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);
      // scale
      ctx.font = '9px Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (const db of TICKS) {
        const y = Math.round(g.yOf(db)) + 0.5;
        ctx.fillStyle = colors.tick;
        ctx.fillRect(g.scaleW - 3, y - 0.5, 3, 1);
        if (db % 12 === 0 || db === -6) { ctx.fillStyle = colors.text; ctx.fillText(String(Math.abs(db)), g.scaleW - 4, y); }
      }
      // A level fills from the floor up in the colour of each zone it reaches.
      const fill = (bar, db, alpha) => {
        if (!(db > FLOOR)) return;
        const zones = [[FLOOR, -18, colors.low], [-18, -6, colors.mid], [-6, 0, colors.high]];
        ctx.globalAlpha = alpha;
        for (const [a, b, c] of zones) {
          if (db <= a) break;
          const y1 = g.yOf(Math.min(db, b));
          const y2 = g.yOf(a);
          ctx.fillStyle = c;
          ctx.fillRect(bar.x, y1, bar.w, y2 - y1);
        }
        ctx.globalAlpha = 1;
      };
      g.bars.forEach((bar, ch) => {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(bar.x, g.top, bar.w, g.bottom - g.top);
        fill(bar, st.peak[ch], 0.45);
        fill(bar, st.rms[ch], 1);
        if (st.hold[ch] > FLOOR) {
          ctx.fillStyle = st.hold[ch] >= 0 ? colors.high : colors.hold;
          ctx.fillRect(bar.x, Math.round(g.yOf(st.hold[ch])) - 1, bar.w, 2);
        }
      });
      // the -1 dBTP ceiling
      const cy = Math.round(g.yOf(CEILING)) + 0.5;
      ctx.strokeStyle = colors.high;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(g.bars[0].x - 1, cy);
      ctx.lineTo(g.bars[1].x + g.bars[1].w + 1, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      return true;
    }

    const engine = () => ui.monitors?.program?.player?.audio || null;
    let raf = 0;
    let last = 0;
    function frame(now) {
      raf = 0;
      const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
      last = now;
      const m = app.playing ? engine()?.meters?.() : null;
      let busy = app.playing;
      for (let ch = 0; ch < 2; ch++) {
        const peak = m ? m.masterChannels?.[ch] ?? -Infinity : -Infinity;
        const rms = m ? m.masterRms?.[ch] ?? -Infinity : -Infinity;
        // rise at once, fall smoothly
        st.peak[ch] = peak >= st.peak[ch] ? peak : Math.max(peak, st.peak[ch] - BAR_FALL * dt);
        st.rms[ch] = rms >= st.rms[ch] ? rms : Math.max(rms, st.rms[ch] - BAR_FALL * dt);
        if (peak >= st.hold[ch]) { st.hold[ch] = peak; st.holdAt[ch] = now; } else if (now - st.holdAt[ch] > HOLD_MS) st.hold[ch] -= HOLD_FALL * dt;
        if (st.peak[ch] < FLOOR) st.peak[ch] = -Infinity;
        if (st.rms[ch] < FLOOR) st.rms[ch] = -Infinity;
        if (st.hold[ch] < FLOOR) st.hold[ch] = -Infinity;
        if (peak > st.max[ch]) { st.max[ch] = peak; read[ch].textContent = peak.toFixed(1); }
        if (peak >= 0 && !st.clip[ch]) { st.clip[ch] = true; clipBtn[ch].classList.add('on'); }
        if (st.peak[ch] > -Infinity || st.hold[ch] > -Infinity) busy = true;
      }
      const shown = draw();
      if (busy && shown) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    const wake = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    offs.push(() => cancelAnimationFrame(raf));
    offs.push(app.on('playing', wake));
    // Back in view: go on falling from where the levels were when the panel left the screen.
    const lit = () => [...st.peak, ...st.rms, ...st.hold].some((x) => x > -Infinity);
    const ro = ide.util.observeSize(box, () => { draw(); if (app.playing || lit()) wake(); });
    offs.push(() => ro.disconnect());
    const theme = new MutationObserver(() => { colors = null; draw(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    offs.push(() => theme.disconnect());
    draw();
    if (app.playing) wake();

    ui.meters = {
      get state() { return JSON.parse(JSON.stringify({ ...st, holdAt: undefined }, (k, v) => (v === -Infinity ? null : v))); },
      get running() { return !!raf; },
      // client geometry for a test that reads the bars from the pixels: each bar's x range and dB -> client y
      geometry() {
        const g = layout();
        const r = canvas.getBoundingClientRect();
        return { bars: g.bars.map((b) => ({ x0: r.left + b.x, x1: r.left + b.x + b.w })), y: (db) => r.top + g.yOf(db), top: r.top + g.top, bottom: r.top + g.bottom, dpr: devicePixelRatio || 1, left: r.left, topPx: r.top };
      },
      canvas,
      reset,
    };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); },
    };
  }

  ui.registerPanel('meters', { title: () => tr('Audio Meters'), mount });
})();
