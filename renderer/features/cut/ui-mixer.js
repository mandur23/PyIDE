// The Audio Track Mixer of Nano Studio Cut (Premiere Pro's Audio Track Mixer, video-editor-features.md section 12):
// a strip per audio track of the sequence (its pan knob, mute and solo, a vertical fader in dB over the track volume,
// a stereo level meter, its name) and a master strip (the sequence's masterGain and the mix's meter). The fader is the
// same track volume as the timeline header's 0-200% (the model keeps dB: 200% is +6.02 dB, 0% is -144 dB, silence).
// A fader or knob drag is one undo step (history.begin/commit); Alt+click puts it back to 0, a double click on the
// value types one. Also the Audio workspace (the mixer, Essential Sound, the meters), added to Cut.ui.workspaces
// before the shell builds its tabs.
//
// The meters read the program player's engine (audioengine meters(): trackChannels, masterChannels) from
// requestAnimationFrame only while the program plays or a level is still falling, and only while the panel is seen.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const { el } = ui;

  // Fader travel: dB at points from the bottom (0) to the top (1), straight lines between, like a console's scale.
  const SCALE = [[-Infinity, 0], [-60, 0.04], [-48, 0.1], [-36, 0.2], [-24, 0.34], [-18, 0.44], [-12, 0.56], [-6, 0.7], [0, 0.84], [6, 1]];
  const TICK_LABELS = [6, 0, -6, -12, -18, -24, -36, -48, -Infinity];
  const SILENT = -144; // the model's 0% (audioengine plays it as silence)
  const TRACK_MAX = 20 * Math.log10(2); // 200%
  const MASTER_MAX = 6;
  const FLOOR = -60;
  const HOLD_MS = 1500;
  const HOLD_FALL = 20;
  const BAR_FALL = 30;

  function posOf(db) {
    if (!(db > SILENT)) return 0;
    if (db <= SCALE[1][0]) return SCALE[1][1] * Math.max(0, Math.min(1, (db - SILENT) / (SCALE[1][0] - SILENT)));
    for (let i = 1; i < SCALE.length - 1; i++) {
      const [d0, p0] = SCALE[i];
      const [d1, p1] = SCALE[i + 1];
      if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
    return 1;
  }
  function dbOf(pos) {
    if (pos <= 0.002) return SILENT;
    if (pos <= SCALE[1][1]) return SILENT + (pos / SCALE[1][1]) * (SCALE[1][0] - SILENT);
    for (let i = 1; i < SCALE.length - 1; i++) {
      const [d0, p0] = SCALE[i];
      const [d1, p1] = SCALE[i + 1];
      if (pos <= p1) return d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0);
    }
    return SCALE[SCALE.length - 1][0];
  }
  const round = (db) => (db <= SILENT ? SILENT : Math.round(db * 10) / 10);
  const dbText = (db) => (!(db > SILENT) ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
  const panText = (p) => (Math.round(p) === 0 ? '0' : String(Math.round(p)));
  const KNOB = '<svg aria-hidden="true" viewBox="0 0 28 28" width="28" height="28"><circle class="ring" cx="14" cy="14" r="11"/><path class="arc" d=""/><line class="mark" x1="14" y1="14" x2="14" y2="4"/></svg>';

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-mixer', undefined, { tabindex: -1 });
    const strips = el('div', 'cut-mx-strips');
    const masterBox = el('div', 'cut-mx-masterbox');
    const empty = el('div', 'cut-mx-empty', tr('The sequence has no audio tracks.'));
    empty.hidden = true;
    root.append(strips, masterBox, empty);
    host.appendChild(root);
    let built = '';
    let list = []; // [{id, master, node, fader, cap, value, knob, panValue, mute, solo, canvas, st}]
    const seq = () => app.sequence;
    const trackOf = (id) => seq()?.tracks.find((t) => t.id === id) || null;

    function valueOf(entry) {
      const s = seq();
      if (!s) return 0;
      return entry.master ? s.masterGain ?? 0 : trackOf(entry.id)?.volume ?? 0;
    }
    function setValue(entry, db) {
      const s = seq();
      if (!s) return;
      const v = round(Math.min(entry.master ? MASTER_MAX : TRACK_MAX, db));
      if (Math.abs(valueOf(entry) - v) < 1e-9) return;
      if (entry.master) ui.exec(app, C.setSequence(s.id, { masterGain: v }));
      else ui.exec(app, C.setTrack(s.id, entry.id, { volume: v <= SILENT ? SILENT : Math.min(TRACK_MAX, v) }));
    }
    async function typeValue(entry) {
      const text = await ide.ui.prompt(entry.master ? tr('Master volume (dB)') : tr('Track volume (dB)'), dbText(valueOf(entry)).replace('-∞', '-inf'));
      if (text == null) return;
      const t = String(text).trim().toLowerCase().replace('db', '').trim();
      const v = /^-?(inf|∞)$/.test(t) ? SILENT : Number(t.replace('+', ''));
      if (Number.isFinite(v)) setValue(entry, v);
    }

    // One drag of a fader: the value follows the pointer from where it was taken (a press on the groove jumps there).
    function faderEvents(entry) {
      const { fader, cap } = entry;
      fader.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        app.setFocus?.('mixer');
        if (e.altKey) { setValue(entry, 0); return; }
        const r = fader.getBoundingClientRect();
        const travel = Math.max(20, r.height - cap.offsetHeight);
        const top = r.top + cap.offsetHeight / 2;
        const onCap = e.target === cap || cap.contains(e.target);
        let p0 = posOf(valueOf(entry));
        const y0 = e.clientY;
        fader.setPointerCapture(e.pointerId);
        app.history.begin(entry.master ? 'Master Volume' : 'Track Volume');
        if (!onCap) { p0 = Math.max(0, Math.min(1, 1 - (e.clientY - top) / travel)); setValue(entry, dbOf(p0)); }
        const move = (ev) => setValue(entry, dbOf(Math.max(0, Math.min(1, p0 - (ev.clientY - y0) / travel))));
        const up = () => {
          fader.removeEventListener('pointermove', move);
          fader.removeEventListener('pointerup', up);
          fader.removeEventListener('lostpointercapture', up);
          app.history.commit();
        };
        fader.addEventListener('pointermove', move);
        fader.addEventListener('pointerup', up);
        fader.addEventListener('lostpointercapture', up);
      });
      entry.value.addEventListener('dblclick', () => typeValue(entry));
    }
    // The pan knob: up or right turns it right, a pixel a step; Alt+click centers it; a double click types it.
    function knobEvents(entry) {
      const { knob } = entry;
      knob.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        app.setFocus?.('mixer');
        const s = seq();
        if (!s) return;
        if (e.altKey) { ui.exec(app, C.setTrack(s.id, entry.id, { pan: 0 })); return; }
        const p0 = trackOf(entry.id)?.pan ?? 0;
        const x0 = e.clientX;
        const y0 = e.clientY;
        knob.setPointerCapture(e.pointerId);
        app.history.begin('Track Pan');
        const move = (ev) => {
          const v = Math.max(-100, Math.min(100, Math.round(p0 + (ev.clientX - x0) - (ev.clientY - y0))));
          if (v !== (trackOf(entry.id)?.pan ?? 0)) ui.exec(app, C.setTrack(seq().id, entry.id, { pan: v }));
        };
        const up = () => {
          knob.removeEventListener('pointermove', move);
          knob.removeEventListener('pointerup', up);
          knob.removeEventListener('lostpointercapture', up);
          app.history.commit();
        };
        knob.addEventListener('pointermove', move);
        knob.addEventListener('pointerup', up);
        knob.addEventListener('lostpointercapture', up);
      });
      knob.addEventListener('dblclick', async () => {
        const text = await ide.ui.prompt(tr('Pan (-100 left to 100 right)'), String(trackOf(entry.id)?.pan ?? 0));
        const v = Number(String(text ?? '').trim());
        if (text != null && Number.isFinite(v)) ui.exec(app, C.setTrack(seq().id, entry.id, { pan: Math.max(-100, Math.min(100, Math.round(v))) }));
      });
    }

    function strip(t, master = false) {
      const node = el('div', `cut-mx-strip${master ? ' master' : ''}`, undefined, { 'data-track': master ? 'master' : t.id });
      const entry = { id: master ? 'master' : t.id, master, node, st: { peak: [-Infinity, -Infinity], hold: [-Infinity, -Infinity], holdAt: [0, 0] } };
      const top = el('div', 'cut-mx-top');
      if (!master) {
        entry.knob = el('div', 'cut-mx-knob', undefined, { role: 'slider', 'aria-label': tr('Pan'), 'aria-valuemin': '-100', 'aria-valuemax': '100', title: tr('Pan: drag to turn, Alt+click to center, double-click to type a value') });
        entry.knob.innerHTML = KNOB;
        entry.panValue = el('span', 'cut-mx-panvalue');
        top.append(entry.knob, entry.panValue);
        const btns = el('div', 'cut-mx-btns');
        entry.mute = ui.button({ label: 'M', title: tr('Mute Track'), toggle: true, cls: 'cut-mx-mute', onClick: () => ui.exec(app, C.setTrack(seq().id, t.id, { mute: !trackOf(t.id)?.mute })) });
        entry.solo = ui.button({ label: 'S', title: tr('Solo Track'), toggle: true, cls: 'cut-mx-solo', onClick: () => ui.exec(app, C.setTrack(seq().id, t.id, { solo: !trackOf(t.id)?.solo })) });
        btns.append(entry.mute, entry.solo);
        top.appendChild(btns);
        knobEvents(entry);
      } else top.appendChild(el('div', 'cut-mx-mastertitle', tr('Master')));
      const body = el('div', 'cut-mx-body');
      const scale = el('div', 'cut-mx-scale');
      for (const d of TICK_LABELS) {
        const l = el('span', 'cut-mx-tick', d === -Infinity ? '-∞' : d > 0 ? `+${d}` : String(d));
        l.style.bottom = `calc((100% - var(--cap-h)) * ${posOf(d === -Infinity ? SILENT : d)} + var(--cap-h) / 2)`;
        scale.appendChild(l);
      }
      entry.fader = el('div', 'cut-mx-fader', undefined, { role: 'slider', 'aria-label': master ? tr('Master Volume') : tr('Track Volume'), 'aria-valuemax': String(master ? MASTER_MAX : 6),
        title: tr('Volume: drag to change, Alt+click for 0 dB, double-click the value to type it') });
      entry.fader.append(el('div', 'cut-mx-groove'), el('div', 'cut-mx-unity'));
      entry.cap = el('div', 'cut-mx-cap');
      entry.fader.appendChild(entry.cap);
      entry.fader.querySelector('.cut-mx-unity').style.bottom = `calc((100% - var(--cap-h)) * ${posOf(0)} + var(--cap-h) / 2)`;
      const meter = el('div', 'cut-mx-meter');
      entry.canvas = el('canvas', 'cut-mx-meter-canvas');
      meter.appendChild(entry.canvas);
      body.append(scale, entry.fader, meter);
      entry.value = el('div', 'cut-mx-value', undefined, { title: tr('Double-click to type a value') });
      const name = el('div', 'cut-mx-name');
      name.append(el('span', 'cut-mx-name-text', master ? tr('Master') : t.name || t.id), el('span', 'cut-mx-name-id', master || !t.name || t.name === t.id ? '' : t.id));
      node.append(top, body, entry.value, name);
      faderEvents(entry);
      return entry;
    }

    function build() {
      const s = seq();
      const audio = (s?.tracks || []).filter((t) => t.kind === 'audio');
      const sig = `${s?.id}|${audio.map((t) => `${t.id}:${t.name}`).join(',')}`;
      if (sig === built) return;
      built = sig;
      strips.replaceChildren();
      masterBox.replaceChildren();
      list = [];
      empty.hidden = !!audio.length || !s;
      for (const t of audio) { const e = strip(t); strips.appendChild(e.node); list.push(e); }
      if (s) { const m = strip(null, true); masterBox.appendChild(m.node); list.push(m); }
    }
    function update() {
      build();
      for (const e of list) {
        const db = valueOf(e);
        e.cap.style.bottom = `calc((100% - var(--cap-h)) * ${posOf(db)})`;
        e.value.textContent = `${dbText(db)} dB`;
        e.fader.setAttribute('aria-valuenow', String(db));
        if (e.master) continue;
        const t = trackOf(e.id);
        if (!t) continue;
        const pan = t.pan ?? 0;
        e.knob.setAttribute('aria-valuenow', String(pan));
        e.panValue.textContent = panText(pan);
        const a = (pan / 100) * 135;
        const rad = (deg) => ((deg - 90) * Math.PI) / 180;
        const pt = (deg) => `${(14 + 11 * Math.cos(rad(deg))).toFixed(2)} ${(14 + 11 * Math.sin(rad(deg))).toFixed(2)}`;
        e.knob.querySelector('.mark').setAttribute('x2', (14 + 10 * Math.cos(rad(a))).toFixed(2));
        e.knob.querySelector('.mark').setAttribute('y2', (14 + 10 * Math.sin(rad(a))).toFixed(2));
        e.knob.querySelector('.arc').setAttribute('d', Math.abs(a) < 0.5 ? '' : `M ${pt(0)} A 11 11 0 0 ${a > 0 ? 1 : 0} ${pt(a)}`);
        e.mute.setPressed(!!t.mute);
        e.solo.setPressed(!!t.solo);
        e.node.classList.toggle('muted', !!t.mute);
        e.node.classList.toggle('soloed', !!t.solo);
      }
    }

    // ---------- meters ----------
    let colors = null;
    const readColors = () => {
      const cs = getComputedStyle(root);
      const v = (n, fb) => cs.getPropertyValue(n).trim() || fb;
      colors = { low: v('--cut-meter-low', '#3fae5a'), mid: v('--cut-meter-mid', '#e6c84a'), high: v('--cut-meter-high', '#e05555'), bg: v('--cut-meter-bg', '#15161a'), hold: v('--gray12', '#eeeeee') };
    };
    function drawMeter(e) {
      const c = e.canvas;
      const box = c.parentNode;
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h || !c.isConnected) return false;
      if (!colors) readColors();
      const dpr = devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const bw = Math.max(2, (w - 1) / 2);
      const yOf = (db) => h - ((Math.max(FLOOR, Math.min(0, db)) - FLOOR) / -FLOOR) * h;
      for (let ch = 0; ch < 2; ch++) {
        const x = ch * (bw + 1);
        g.fillStyle = colors.bg;
        g.fillRect(x, 0, bw, h);
        const db = e.st.peak[ch];
        if (db > FLOOR) {
          for (const [a, b, col] of [[FLOOR, -18, colors.low], [-18, -6, colors.mid], [-6, 0, colors.high]]) {
            if (db <= a) break;
            const y1 = yOf(Math.min(db, b));
            g.fillStyle = col;
            g.fillRect(x, y1, bw, yOf(a) - y1);
          }
        }
        if (e.st.hold[ch] > FLOOR) {
          g.fillStyle = e.st.hold[ch] >= 0 ? colors.high : colors.hold;
          g.fillRect(x, Math.round(yOf(e.st.hold[ch])) - 1, bw, 2);
        }
      }
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
      let shown = false;
      for (const e of list) {
        const lv = !m ? [-Infinity, -Infinity] : e.master ? m.masterChannels || [-Infinity, -Infinity] : m.trackChannels?.[e.id] || [m.tracks?.[e.id] ?? -Infinity, m.tracks?.[e.id] ?? -Infinity];
        for (let ch = 0; ch < 2; ch++) {
          const v = lv[ch] ?? -Infinity;
          const st = e.st;
          st.peak[ch] = v >= st.peak[ch] ? v : Math.max(v, st.peak[ch] - BAR_FALL * dt);
          if (v >= st.hold[ch]) { st.hold[ch] = v; st.holdAt[ch] = now; } else if (now - st.holdAt[ch] > HOLD_MS) st.hold[ch] -= HOLD_FALL * dt;
          if (st.peak[ch] < FLOOR) st.peak[ch] = -Infinity;
          if (st.hold[ch] < FLOOR) st.hold[ch] = -Infinity;
          if (st.peak[ch] > -Infinity || st.hold[ch] > -Infinity) busy = true;
        }
        if (drawMeter(e)) shown = true;
      }
      if (busy && shown) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    const wake = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    offs.push(() => cancelAnimationFrame(raf));
    offs.push(app.on('playing', wake));
    offs.push(app.on('project', () => update()));
    offs.push(app.on('history', () => update()));
    offs.push(app.on('sequence', () => { built = ''; update(); }));
    const ro = ide.util.observeSize(root, () => { for (const e of list) drawMeter(e); if (app.playing) wake(); });
    offs.push(() => ro.disconnect());
    const theme = new MutationObserver(() => { colors = null; for (const e of list) drawMeter(e); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    offs.push(() => theme.disconnect());
    update();
    if (app.playing) wake();

    ui.mixer = {
      get strips() { return list.map((e) => ({ id: e.id, master: e.master, value: valueOf(e), peak: e.st.peak.map((v) => (v === -Infinity ? null : v)) })); },
      get running() { return !!raf; },
      // client geometry for a test: the fader's travel (top and bottom of the cap's center) and the cap's center now
      fader(id) {
        const e = list.find((x) => x.id === id);
        if (!e) return null;
        const r = e.fader.getBoundingClientRect();
        const c = e.cap.getBoundingClientRect();
        return { x: r.left + r.width / 2, top: r.top + c.height / 2, bottom: r.bottom - c.height / 2, cap: { x: c.left + c.width / 2, y: c.top + c.height / 2 } };
      },
      rect: (id, part) => list.find((x) => x.id === id)?.[part]?.getBoundingClientRect() || null,
      posOf,
      dbOf,
      refresh: () => { built = ''; update(); },
    };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); if (ui.mixer?.refresh) delete ui.mixer; },
      focus: () => root.focus({ preventScroll: true }),
    };
  }

  ui.registerPanel('mixer', { title: () => tr('Audio Track Mixer'), mount });

  // The Audio workspace, as Premiere's: the mixer beside the program monitor, Essential Sound and the effects on the
  // right, the timeline with the meters below.
  if (Array.isArray(ui.workspaces) && !ui.workspaces.some((w) => w.id === 'audio')) {
    const at = ui.workspaces.findIndex((w) => w.id === 'export');
    ui.workspaces.splice(at < 0 ? ui.workspaces.length : at, 0, { id: 'audio', title: () => tr('Audio'), rows: [
      { size: 56, slots: [{ size: 40, panels: ['mixer', 'source', 'controls'] }, { size: 38, panels: ['program'] }, { size: 22, panels: ['essential', 'effects', 'history'], dock: true }] },
      { size: 44, slots: [{ size: 22, panels: ['project', 'markers'] }, { size: 72, panels: ['timeline'] }, { size: 6, panels: ['meters'] }] },
    ] });
  }
})();
