// The audio effects on screen in Nano Studio Cut: the frequency response graph the effect controls panel draws above
// the parameters of the Parametric Equalizer (and of Bass, Treble and the DeHummer), from the same filters the mixer
// runs (Cut.audiofx.response) at the playhead's parameter values; and the Essential Sound panel (Premiere's Essential
// Sound, in short): the selected clips' audio type (the clip role Auto Ducking reads) and one-click actions that add
// effects with settings for speech or call the automation (Auto Ducking, Isolate Voice, the loudness matches).
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const { el } = ui;

  // ---------- the frequency response graph ----------
  const F_LO = 20;
  const F_HI = 20000;
  const DB_RANGE = 24;
  const GRID_F = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const GRID_DB = [-18, -12, -6, 0, 6, 12, 18];
  const fLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
  // The graphs on screen, redrawn when the theme changes (one observer for all; a graph off the page leaves the set).
  const live = new Set();
  new MutationObserver(() => { for (const g of live) { if (g.node.isConnected) g.redraw(); else live.delete(g); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function responseView(dsp) {
    return ({ app, clipId, effectId }) => {
      const node = el('div', 'cut-ec-graph', undefined, { 'data-graph': effectId });
      const canvas = el('canvas', 'cut-ec-graph-canvas', undefined, { 'aria-label': tr('Frequency response') });
      node.appendChild(canvas);
      let shown = null;
      const clip = () => app.sequence?.clips.find((c) => c.id === clipId) || null;
      // The parameters at the playhead (keyframes included), as the mixer would read them there.
      function params() {
        const c = clip();
        const e = c?.effects.find((x) => x.id === effectId);
        if (!e) return null;
        const def = Cut.effects.get(e.type);
        const p = Cut.effects.resolve(e.type, e.params || {});
        for (const d of def.params) {
          if (!d.keyframable) continue;
          const v = ui.edit.valueAt(app, c, `effects.${e.id}.${d.id}`);
          if (typeof v === 'number') p[d.id] = v;
        }
        return { p, on: e.on !== false };
      }
      function draw() {
        const got = params();
        const w = node.clientWidth;
        const h = node.clientHeight;
        if (!got || !w || !h) return;
        const key = `${w}x${h}|${JSON.stringify(got)}|${document.documentElement.dataset.theme}`;
        if (key === shown) return;
        shown = key;
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const cs = getComputedStyle(node);
        const col = (n, fb) => cs.getPropertyValue(n).trim() || fb;
        const grid = col('--gray4', '#43454a');
        const text = col('--gray8', '#868a91');
        const accent = col('--cut-accent', '#e8743b');
        g.fillStyle = col('--gray1', '#1e1f22');
        g.fillRect(0, 0, w, h);
        const xOf = (f) => (Math.log10(f / F_LO) / Math.log10(F_HI / F_LO)) * w;
        const yOf = (d) => h / 2 - (Math.max(-DB_RANGE, Math.min(DB_RANGE, d)) / DB_RANGE) * (h / 2 - 4);
        g.font = '9px Consolas, monospace';
        g.lineWidth = 1;
        for (const f of GRID_F) {
          const x = Math.round(xOf(f)) + 0.5;
          g.strokeStyle = grid;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
          g.fillStyle = text;
          g.textBaseline = 'bottom';
          g.textAlign = 'center';
          if (f !== 50) g.fillText(fLabel(f), x, h - 1);
        }
        for (const d of GRID_DB) {
          const y = Math.round(yOf(d)) + 0.5;
          g.strokeStyle = grid;
          g.globalAlpha = d === 0 ? 1 : 0.6;
          g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
          g.globalAlpha = 1;
          if (d % 12 === 0 && d !== 0) { g.fillStyle = text; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(`${d > 0 ? '+' : ''}${d}`, 2, y); }
        }
        // the response, sampled at every 2 pixels
        const n = Math.max(32, Math.round(w / 2));
        const freqs = Array.from({ length: n + 1 }, (_, i) => F_LO * (F_HI / F_LO) ** (i / n));
        const resp = Cut.audiofx.response(dsp, got.p, freqs, 48000);
        g.strokeStyle = got.on ? accent : text;
        g.lineWidth = 1.6;
        g.beginPath();
        freqs.forEach((f, i) => (i ? g.lineTo(xOf(f), yOf(resp[i])) : g.moveTo(xOf(f), yOf(resp[i]))));
        g.stroke();
        // the EQ's bands as handles at their frequency and gain
        if (dsp === 'eq') {
          const bands = [['ls', 'lsGain'], ['b1', 'b1Gain'], ['b2', 'b2Gain'], ['b3', 'b3Gain'], ['hs', 'hsGain'], ['hp', null], ['lp', null]];
          for (const [b, gain] of bands) {
            if (!got.p[`${b}On`]) continue;
            g.fillStyle = got.on ? accent : text;
            g.beginPath();
            g.arc(xOf(got.p[`${b}Freq`]), yOf(gain ? got.p[gain] : 0), 3, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
      const ro = new ResizeObserver(() => { if (!node.isConnected) { ro.disconnect(); return; } shown = null; draw(); });
      ro.observe(node);
      live.add({ node, redraw: () => { shown = null; draw(); } });
      return { node, update: draw, graph: { params } };
    };
  }
  ui.effectViews = Object.assign(ui.effectViews || {}, {
    'audio.eq': responseView('eq'),
    'audio.bass': responseView('bass'),
    'audio.treble': responseView('treble'),
    'audio.dehum': responseView('dehum'),
  });

  // ---------- Essential Sound ----------
  // Effect settings the panel adds (the parameters not named keep their defaults).
  const PRESETS = {
    clarity: [
      ['audio.eq', { hpOn: true, hpFreq: 80, hpSlope: '24', b1Freq: 250, b1Gain: -2, b1Q: 1, b2Freq: 3000, b2Gain: 3, b2Q: 1, hsFreq: 10000, hsGain: 1.5 }],
      ['audio.compressor', { threshold: -24, ratio: 3, attack: 5, release: 120, knee: 6, makeup: 4 }],
    ],
    hum50: [['audio.dehum', { frequency: '50' }]],
    hum60: [['audio.dehum', { frequency: '60' }]],
    gate: [['audio.gate', { threshold: -50, attack: 2, hold: 80, release: 150, range: 18 }]],
    limit: [['audio.limiter', { ceiling: -1, release: 50, truePeak: true }]],
  };
  const ROLES = [['dialogue', 'Dialogue'], ['music', 'Music'], ['effects', 'Sound Effects'], ['ambience', 'Ambience']];

  // The audio clips the panel works on: the selected ones and the audio linked to selected video.
  const audioClips = (app) => ui.auto?.soundClips?.(app, { all: false }).filter((c) => app.sequence?.tracks.find((t) => t.id === c.track)?.kind === 'audio') || [];
  function addEffects(app, preset, label) {
    const seq = app.sequence;
    const clips = audioClips(app);
    if (!seq || !clips.length) { ui.toast(tr('Select audio clips first.')); return null; }
    const cmds = [];
    for (const c of clips) for (const [type, params] of PRESETS[preset]) cmds.push(C.addEffect(seq.id, c.id, type, null, params));
    return ui.exec(app, C.batch(label, cmds));
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-es', undefined, { tabindex: -1 });
    host.appendChild(root);
    const head = el('div', 'cut-es-head');
    const sel = el('div', 'cut-es-sel');
    head.appendChild(sel);
    const section = (title) => {
      const s = el('div', 'cut-es-sec');
      s.appendChild(el('div', 'cut-es-title', title));
      root.appendChild(s);
      return s;
    };
    root.appendChild(head);
    const types = section(tr('Audio Type'));
    const roleBox = el('div', 'cut-es-roles');
    const roleBtns = ROLES.map(([id, name]) => {
      const b = ui.button({ label: tr(name), toggle: true, cls: 'cut-es-role', onClick: () => { ui.auto?.setRole?.(app, audioClips(app).every((c) => c.role === id) ? null : id); } });
      b.dataset.role = id;
      return b;
    });
    roleBox.append(...roleBtns);
    types.appendChild(roleBox);
    const action = (label, run, cls) => {
      const b = ui.button({ label, onClick: () => { Promise.resolve().then(run).catch((err) => ui.report(err)); }, cls: `cut-es-action${cls ? ` ${cls}` : ''}` });
      return b;
    };
    const dialogue = section(tr('Dialogue'));
    dialogue.append(
      action(tr('Clarity (EQ and Compressor)'), () => addEffects(app, 'clarity', 'Clarity'), 'clarity'),
      action(tr('Reduce Hum (50 Hz)'), () => addEffects(app, 'hum50', 'Reduce Hum'), 'hum50'),
      action(tr('Reduce Hum (60 Hz)'), () => addEffects(app, 'hum60', 'Reduce Hum'), 'hum60'),
      action(tr('Noise Gate'), () => addEffects(app, 'gate', 'Noise Gate'), 'gate'),
      action(tr('Isolate Voice'), () => ui.voice?.isolate?.(app), 'isolate'),
    );
    const music = section(tr('Music'));
    music.append(action(tr('Auto Ducking…'), () => ui.auto?.autoDuck?.(app), 'duck'));
    const loud = section(tr('Loudness'));
    loud.append(
      action(tr('Match Clip Loudness…'), () => ui.auto?.matchClipLoudness?.(app), 'clipLoudness'),
      action(tr('Match Loudness…'), () => ui.auto?.matchLoudness?.(app), 'loudness'),
      action(tr('Hard Limiter (-1 dB)'), () => addEffects(app, 'limit', 'Hard Limiter'), 'limit'),
    );
    const hint = el('div', 'cut-es-hint', tr('Auto Ducking lowers the clips marked Music under the ones marked Dialogue.'));
    root.appendChild(hint);

    function refresh() {
      const clips = audioClips(app);
      sel.textContent = clips.length ? tr('Selected audio clips: {n}', { n: clips.length }) : tr('Select audio clips in the timeline.');
      for (const b of roleBtns) b.setPressed(!!clips.length && clips.every((c) => c.role === b.dataset.role));
      for (const b of root.querySelectorAll('.cut-es-role, .cut-es-action.clarity, .cut-es-action.hum50, .cut-es-action.hum60, .cut-es-action.gate, .cut-es-action.limit, .cut-es-action.isolate, .cut-es-action.clipLoudness')) b.disabled = !clips.length;
    }
    offs.push(app.on('selection', refresh), app.on('project', refresh), app.on('sequence', refresh));
    refresh();
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); },
      focus: () => root.focus({ preventScroll: true }),
    };
  }
  ui.registerPanel('essential', { title: () => tr('Essential Sound'), mount });
  ui.audiofx = { PRESETS, addEffects, audioClips };
})();
