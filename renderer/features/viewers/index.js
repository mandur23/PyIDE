// File viewers: images, video, audio waveforms, NumPy arrays, model files, and Markdown / CSV / JSONL views with an
// embedded editor. Each viewer is a custom tab mounted through ide.registerFileViewer (see FEATURES.md); it keeps
// all of its state in its own host element, so several can be open at once, in split panes and in detached windows.
(() => {
  const { el, basename, dirname } = ide.util;
  const monaco = ide.monaco;

  // ---------- helpers ----------
  const ext = (p) => (p.match(/\.([^.\\/]+)$/)?.[1] || '').toLowerCase();
  const byExt = (...list) => (p) => list.includes(ext(p));
  const user = (node) => { node.dataset.userText = ''; return node; };
  const userEl = (tag, cls, text) => user(el(tag, cls, text));
  const invoke = (ch, ...args) => ide.api.invoke(ch, ...args);
  const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // file:// URL for a Windows path, each segment encoded (#, %, spaces and Korean names all survive).
  function fileUrl(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    if (p.startsWith('\\\\')) return `file://${parts.slice(2).map(encodeURIComponent).join('/')}`;
    return `file:///${parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/')}`;
  }

  // Resolves a relative (URL-style) reference against a folder; null when it climbs above the drive.
  function resolveRel(dir, ref) {
    let rel = ref.split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch {}
    if (/^[a-zA-Z]:[\\/]/.test(rel)) return rel.replace(/\//g, '\\');
    const out = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
    for (const seg of rel.split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length <= 1) return null; out.pop(); } else out.push(seg);
    }
    return out.join('\\');
  }

  function fmtBytes(n) {
    if (n == null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${i ? v.toFixed(v < 10 ? 2 : 1) : v} ${units[i]}`;
  }
  function fmtNum(v) {
    if (v == null || Number.isNaN(v)) return String(v);
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    const s = v.toPrecision(6);
    return s.includes('e') ? s : String(Number(s));
  }
  function fmtCount(n) {
    const short = n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : null;
    return short ? `${short} (${n.toLocaleString('en-US')})` : n.toLocaleString('en-US');
  }
  function fmtTime(t) {
    if (!Number.isFinite(t)) return '--:--';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }
  const fmtShape = (shape) => (shape ? `(${shape.join(', ')}${shape.length === 1 ? ',' : ''})` : '?');
  const cssVar = (node, name) => getComputedStyle(node).getPropertyValue(name).trim();
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };

  function button(label, title, onclick, cls = 'vw-btn') {
    const b = el('button', cls, label);
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }

  // Segmented toggle: options [{value, label, title}] -> {el, set(value)}.
  function segmented(options, value, onChange) {
    const box = el('div', 'vw-seg');
    const btns = new Map();
    for (const o of options) {
      const b = el('button', 'vw-seg-btn', o.label);
      b.dataset.value = o.value;
      if (o.title) b.title = o.title;
      b.onclick = () => { set(o.value); onChange(o.value); };
      btns.set(o.value, b);
      box.appendChild(b);
    }
    const set = (v) => { for (const [k, b] of btns) b.classList.toggle('active', k === v); };
    set(value);
    return { el: box, set };
  }

  function selectBox(options, value, title, onChange) {
    const s = el('select', 'vw-select');
    if (title) s.title = title;
    for (const [v, label] of options) s.add(new Option(label, v));
    s.value = String(value);
    s.onchange = () => onChange(s.value);
    return s;
  }

  const toolbar = () => el('div', 'vw-toolbar');
  const sep = () => el('span', 'vw-sep');
  const spacer = () => el('span', 'vw-spacer');

  // A message card that replaces a viewer whose content cannot be shown, with the usual file actions.
  function fallbackCard(host, path, message, detail) {
    const card = el('div', 'vw-fallback');
    card.appendChild(userEl('div', 'vw-fallback-title', basename(path)));
    card.appendChild(el('div', 'vw-muted', message));
    if (detail) card.appendChild(userEl('pre', 'vw-error', detail));
    const row = el('div', 'vw-actions');
    row.append(
      button(tr('Open with Default App'), null, () => invoke('shell:openPath', path), 'secondary'),
      button(tr('Show in Explorer'), null, () => invoke('shell:showInFolder', path), 'secondary'),
    );
    card.appendChild(row);
    host.appendChild(card);
    return card;
  }

  // Re-runs `fn` when the theme changes (canvas colors come from CSS variables).
  const onTheme = (fn) => ide.on('settingsChanged', (k) => { if (k === 'appearance.theme') requestAnimationFrame(fn); });

  // Interpreter for Python probes. Detached windows have no project, so they look interpreters up once.
  let interpLookup = null;
  async function interpreter() {
    if (ide.currentInterp()) return ide.currentInterp();
    if (ide.detached && ide.reloadInterpreters) {
      interpLookup ||= ide.reloadInterpreters().catch(() => {});
      await interpLookup;
      return ide.currentInterp();
    }
    // The main window may still be detecting interpreters while the project opens.
    return new Promise((resolve) => {
      const off = ide.on('interpreterChanged', (it) => { off(); clearTimeout(t); resolve(it || null); });
      const t = setTimeout(() => { off(); resolve(ide.currentInterp()); }, 15000);
    });
  }
  async function probe(mode, path, arg) {
    const it = await interpreter();
    if (!it) return { ok: false, noInterpreter: true };
    const r = await invoke('viewers:probe', { cmd: it.cmd, args: it.args }, mode, path, arg).catch((e) => ({ ok: false, error: cleanError(e) }));
    r.interp = it.label;
    return r;
  }

  // ---------- images ----------
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif'];

  function mountImage(host, { path }) {
    host.classList.add('vw', 'vw-image');
    const bar = toolbar();
    const zoomIn = button('＋', tr('Zoom In'), () => zoomAtCenter(1.25));
    const zoomOut = button('－', tr('Zoom Out'), () => zoomAtCenter(0.8));
    const fitBtn = button(tr('Fit'), tr('Zoom to Fit'), () => fit());
    const actualBtn = button('1:1', tr('Actual Size'), () => actual());
    const info = el('span', 'vw-info');
    const dims = userEl('span', 'vw-dims');
    const size = userEl('span', 'vw-size');
    const zoomLabel = userEl('span', 'vw-zoom');
    const cursor = userEl('span', 'vw-cursor');
    info.append(dims, sep(), size, sep(), zoomLabel, cursor);
    bar.append(zoomIn, zoomOut, fitBtn, actualBtn, spacer(), info);

    const stage = el('div', 'vw-stage');
    const box = el('div', 'vw-img-box vw-checker');
    const img = el('img', 'vw-img');
    img.draggable = false;
    box.appendChild(img);
    stage.appendChild(box);
    host.append(bar, stage);

    let w = 0;
    let h = 0;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let mode = 'auto'; // auto: 100% if it fits, else fit; fit; manual

    invoke('viewers:stat', path).then((s) => { size.textContent = fmtBytes(s.size); }).catch(() => {});

    function apply() {
      box.style.width = `${w * scale}px`;
      box.style.height = `${h * scale}px`;
      box.style.transform = `translate(${tx}px, ${ty}px)`;
      box.classList.toggle('pixelated', scale >= 3);
      zoomLabel.textContent = `${Math.round(scale * 1000) / 10}%`;
      host.dataset.zoom = String(scale);
    }
    function center() {
      const r = stage.getBoundingClientRect();
      tx = Math.round((r.width - w * scale) / 2);
      ty = Math.round((r.height - h * scale) / 2);
    }
    function fit(keepMode) {
      const r = stage.getBoundingClientRect();
      if (!w || !r.width) return;
      scale = Math.max(0.01, Math.min((r.width - 24) / w, (r.height - 24) / h));
      if (!keepMode) mode = 'fit';
      center();
      apply();
    }
    function actual() {
      mode = 'manual';
      scale = 1;
      center();
      apply();
    }
    function autoSize() {
      const r = stage.getBoundingClientRect();
      if (!w || !r.width) return;
      if (w <= r.width - 24 && h <= r.height - 24) { scale = 1; center(); apply(); } else fit(true);
    }
    function zoomAt(factor, cx, cy) {
      const ns = Math.min(64, Math.max(0.01, scale * factor));
      tx = cx - (cx - tx) * (ns / scale);
      ty = cy - (cy - ty) * (ns / scale);
      scale = ns;
      mode = 'manual';
      apply();
    }
    function zoomAtCenter(f) {
      const r = stage.getBoundingClientRect();
      zoomAt(f, r.width / 2, r.height / 2);
    }

    img.onload = () => {
      w = img.naturalWidth || 300;
      h = img.naturalHeight || 150;
      dims.textContent = `${w} × ${h}`;
      host.dataset.width = String(w);
      host.dataset.height = String(h);
      host.dataset.loaded = 'true';
      autoSize();
    };
    img.onerror = () => {
      host.replaceChildren();
      host.classList.add('vw-center');
      fallbackCard(host, path, tr('This image cannot be displayed.'));
    };
    img.src = `${fileUrl(path)}?v=${Date.now()}`;

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      if (e.ctrlKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else {
        tx -= e.shiftKey ? e.deltaY : e.deltaX;
        ty -= e.shiftKey ? 0 : e.deltaY;
        mode = 'manual';
        apply();
      }
    }, { passive: false });
    stage.addEventListener('mousedown', (down) => {
      if (down.button !== 0 && down.button !== 1) return;
      down.preventDefault();
      host.focus();
      const sx = down.clientX - tx;
      const sy = down.clientY - ty;
      stage.classList.add('panning');
      const move = (e) => { tx = e.clientX - sx; ty = e.clientY - sy; mode = 'manual'; apply(); };
      const up = () => { stage.classList.remove('panning'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    stage.addEventListener('mousemove', (e) => {
      if (!w) return;
      const r = stage.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left - tx) / scale);
      const y = Math.floor((e.clientY - r.top - ty) / scale);
      cursor.textContent = x >= 0 && y >= 0 && x < w && y < h ? ` · ${x}, ${y}` : '';
    });
    stage.addEventListener('mouseleave', () => { cursor.textContent = ''; });
    stage.addEventListener('dblclick', () => (mode === 'fit' ? actual() : fit()));
    host.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoomAtCenter(1.25);
      else if (e.key === '-') zoomAtCenter(0.8);
      else if (e.key === '0') fit();
      else if (e.key === '1') actual();
      else return;
      e.preventDefault();
    });

    const ro = ide.util.observeSize(stage, () => {
      if (mode === 'fit') fit();
      else if (mode === 'auto') autoSize();
    });
    return { dispose: () => ro.disconnect() };
  }

  // ---------- video ----------
  const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'avi', 'mkv', 'ogv'];

  function mountVideo(host, ctx) {
    const { path } = ctx;
    host.classList.add('vw', 'vw-video');
    let inner = null;
    const video = el('video', 'vw-video-el');
    video.controls = true;
    video.preload = 'metadata';
    let fps = Number(ide.settings.get('viewers.videoFps', 30)) || 30;

    const bar = toolbar();
    const prev = button('⏮', tr('Previous Frame (,)'), () => step(-1));
    const next = button('⏭', tr('Next Frame (.)'), () => step(1));
    const speed = selectBox([['0.25', '0.25×'], ['0.5', '0.5×'], ['1', '1×'], ['1.5', '1.5×'], ['2', '2×']], '1', tr('Playback Speed'),
      (v) => { video.playbackRate = Number(v); });
    const rate = selectBox([['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']], fps, tr('Frame rate used for frame stepping'),
      (v) => { fps = Number(v); ide.settings.set('viewers.videoFps', fps); readout(); });
    const save = button(tr('Save Frame as PNG'), tr('Save the current frame next to the video'), () => saveFrame());
    const status = el('span', 'vw-status');
    const time = userEl('span', 'vw-readout');
    const dims = userEl('span', 'vw-dims');
    bar.append(prev, next, el('span', 'vw-label', tr('Speed:')), speed, rate, save, status, spacer(), dims, sep(), time);

    const stage = el('div', 'vw-stage vw-video-stage');
    stage.appendChild(video);
    host.append(bar, stage);

    const frameOf = (t) => Math.floor(t * fps + 1e-3);
    function readout() {
      const d = video.duration;
      const f = frameOf(video.currentTime);
      const total = Number.isFinite(d) ? Math.round(d * fps) : 0;
      time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}  ·  ${tr('Frame')} ${f} / ${total}`;
      host.dataset.frame = String(f);
    }
    function step(d) {
      if (!Number.isFinite(video.duration)) return;
      video.pause();
      const target = Math.max(0, Math.min(frameOf(video.currentTime) + d, Math.floor(video.duration * fps - 1e-6)));
      video.currentTime = target / fps + 0.001;
      host.dataset.frame = String(target);
    }
    async function saveFrame() {
      if (!video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        const p = await invoke('viewers:saveFrame', path, bytes, frameOf(video.currentTime));
        status.textContent = tr('Saved {name}', { name: basename(p) });
        status.classList.remove('error');
        host.dataset.savedFrame = p;
        ide.refreshTree?.();
      } catch (e) {
        status.textContent = tr('Could not save the frame: {error}', { error: cleanError(e) });
        status.classList.add('error');
      }
    }

    let frameCb = null;
    let done = false; // switched to the audio viewer, failed, or closed
    const track = () => {
      readout();
      if (video.requestVideoFrameCallback) frameCb = video.requestVideoFrameCallback(track);
    };
    video.addEventListener('loadedmetadata', () => {
      // A WebM/MP4 with no video track is audio: show the waveform viewer instead.
      if (!video.videoWidth && !video.videoHeight) {
        done = true;
        video.removeAttribute('src');
        video.load();
        host.replaceChildren();
        host.classList.remove('vw-video');
        inner = mountAudio(host, ctx);
        return;
      }
      dims.textContent = `${video.videoWidth} × ${video.videoHeight}`;
      host.dataset.loaded = 'true';
      readout();
      track();
    });
    video.addEventListener('timeupdate', readout);
    video.addEventListener('seeked', readout);
    video.addEventListener('error', () => {
      if (done) return;
      done = true;
      host.replaceChildren();
      host.classList.add('vw-center');
      host.dataset.unsupported = 'true';
      fallbackCard(host, path, tr('This video format cannot be played here.'));
    });
    host.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || /^(SELECT|INPUT)$/.test(e.target.tagName)) return;
      if (e.key === ',') step(-1);
      else if (e.key === '.') step(1);
      else if (e.key === ' ' && e.target !== video) { if (video.paused) video.play(); else video.pause(); } else return;
      e.preventDefault();
    });
    video.src = fileUrl(path);

    return {
      dispose: () => {
        done = true;
        if (frameCb && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCb);
        video.pause();
        video.removeAttribute('src');
        video.load();
        inner?.dispose?.();
      },
    };
  }

  // ---------- audio ----------
  const AUDIO_EXT = ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac'];
  const MAX_DECODE = 300 * 1024 * 1024;
  // Decoded audio takes 4 bytes per sample and channel: an hour of stereo MP3 (~60 MB) would decode to 1.3 GB at its own
  // rate. Long files decode at a lower rate instead, which is still plenty for drawing peaks.
  const MAX_PCM = 256 * 1024 * 1024;

  // Sample rate and channel count from the container header (decodeAudioData resamples, so it cannot tell).
  function sniffAudio(b) {
    const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    try {
      if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
        for (let o = 12; o + 8 <= b.length;) {
          const id = str(o, 4);
          const len = dv.getUint32(o + 4, true);
          if (id === 'fmt ') return { format: 'WAV', channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
          o += 8 + len + (len & 1);
        }
      }
      if (str(0, 4) === 'fLaC') {
        return { format: 'FLAC', rate: (b[18] << 12) | (b[19] << 4) | (b[20] >> 4), channels: ((b[20] >> 1) & 7) + 1, bits: (((b[20] & 1) << 4) | (b[21] >> 4)) + 1 };
      }
      if (str(0, 4) === 'OggS') {
        const head = str(0, Math.min(b.length, 512));
        let i = head.indexOf('OpusHead');
        if (i >= 0) return { format: 'Opus', channels: b[i + 9], rate: 48000 };
        i = head.indexOf('\x01vorbis');
        if (i >= 0) return { format: 'Vorbis', channels: b[i + 11], rate: dv.getUint32(i + 12, true) };
      }
      let o = 0;
      if (str(0, 3) === 'ID3') o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
      for (const end = Math.min(b.length - 4, o + 65536); o < end; o++) {
        if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
        const ver = (b[o + 1] >> 3) & 3;
        const layer = (b[o + 1] >> 1) & 3;
        const ri = (b[o + 2] >> 2) & 3;
        if (ver === 1 || layer === 0 || ri === 3) continue;
        const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[ver];
        return { format: 'MP3', rate: rates[ri], channels: (b[o + 3] >> 6) === 3 ? 1 : 2 };
      }
    } catch {}
    return null;
  }

  function mountAudio(host, { path }) {
    host.classList.add('vw', 'vw-audio');
    const audio = new Audio();
    audio.preload = 'auto';
    const bar = toolbar();
    const play = button('▶', tr('Play'), () => toggle(), 'vw-btn vw-play');
    const time = userEl('span', 'vw-readout', '0:00.000 / --:--');
    const info = userEl('span', 'vw-info');
    const status = el('span', 'vw-status');
    bar.append(play, time, status, spacer(), info);

    const stage = el('div', 'vw-wave-stage');
    const canvas = el('canvas', 'vw-wave');
    const hover = userEl('div', 'vw-wave-hover hidden');
    stage.append(canvas, hover);
    host.append(bar, stage);

    let peaks = null; // per channel: Float32Array [min, max, min, max, ...] at BUCKETS resolution
    let duration = NaN;
    let raf = 0;
    let disposed = false;

    function toggle() {
      if (!audio.src) return;
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    }
    const sync = () => {
      play.textContent = audio.paused ? '▶' : '⏸';
      play.title = audio.paused ? tr('Play') : tr('Pause');
    };
    audio.addEventListener('play', () => { sync(); loop(); });
    audio.addEventListener('pause', () => { sync(); draw(); });
    audio.addEventListener('ended', () => { sync(); draw(); });
    audio.addEventListener('timeupdate', () => { readout(); });
    audio.addEventListener('seeked', () => { readout(); draw(); });
    audio.addEventListener('loadedmetadata', () => { if (!Number.isFinite(duration)) duration = audio.duration; readout(); });
    const readout = () => { time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(duration)}`; };
    // The element's duration once its metadata has loaded; NaN when it cannot tell.
    const mediaDuration = () => new Promise((resolve) => {
      if (audio.readyState >= 1) { resolve(audio.duration); return; }
      const done = () => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', done);
        resolve(audio.duration);
      };
      const timer = setTimeout(done, 10000);
      audio.addEventListener('loadedmetadata', done);
      audio.addEventListener('error', done);
    });
    const loop = () => {
      cancelAnimationFrame(raf);
      draw();
      readout();
      if (!audio.paused && !disposed) raf = requestAnimationFrame(loop);
    };

    function draw() {
      const dpr = devicePixelRatio || 1;
      const W = Math.max(1, Math.floor(stage.clientWidth));
      const H = Math.max(1, Math.floor(stage.clientHeight));
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
      }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = cssVar(host, '--gray1');
      g.fillRect(0, 0, W, H);
      if (!peaks) return;
      const lanes = peaks.length;
      const laneH = H / lanes;
      const played = Number.isFinite(duration) && duration > 0 ? (audio.currentTime / duration) * W : 0;
      const colors = { base: cssVar(host, '--blue8'), played: cssVar(host, '--green6'), mid: cssVar(host, '--gray3') };
      for (let c = 0; c < lanes; c++) {
        const p = peaks[c];
        const buckets = p.length / 2;
        const mid = laneH * c + laneH / 2;
        const amp = laneH / 2 - 4;
        g.fillStyle = colors.mid;
        g.fillRect(0, Math.round(mid), W, 1);
        for (let x = 0; x < W; x++) {
          const a = Math.floor((x / W) * buckets);
          const b = Math.max(a + 1, Math.floor(((x + 1) / W) * buckets));
          let lo = 1;
          let hi = -1;
          for (let i = a; i < b; i++) { if (p[2 * i] < lo) lo = p[2 * i]; if (p[2 * i + 1] > hi) hi = p[2 * i + 1]; }
          if (hi < lo) continue;
          g.fillStyle = x < played ? colors.played : colors.base;
          const y0 = mid - hi * amp;
          g.fillRect(x, y0, 1, Math.max(1, (hi - lo) * amp));
        }
        if (c > 0) { g.fillStyle = colors.mid; g.fillRect(0, laneH * c, W, 1); }
      }
      if (played > 0) { g.fillStyle = cssVar(host, '--gray12'); g.fillRect(Math.round(played), 0, 1, H); }
    }

    stage.addEventListener('mousedown', (e) => {
      if (!Number.isFinite(duration) || !audio.src) return;
      const r = stage.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
      host.dataset.seeked = String(audio.currentTime);
      readout();
      draw();
    });
    stage.addEventListener('mousemove', (e) => {
      if (!Number.isFinite(duration)) return;
      const r = stage.getBoundingClientRect();
      hover.classList.remove('hidden');
      hover.style.left = `${e.clientX - r.left}px`;
      hover.textContent = fmtTime(((e.clientX - r.left) / r.width) * duration);
    });
    stage.addEventListener('mouseleave', () => hover.classList.add('hidden'));
    host.addEventListener('keydown', (e) => {
      if (e.key === ' ' && !e.ctrlKey && e.target.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
    });

    async function load() {
      status.textContent = tr('Decoding audio…');
      let st;
      try { st = await invoke('viewers:stat', path); } catch (e) { status.textContent = cleanError(e); return; }
      audio.src = fileUrl(path);
      if (st.size > MAX_DECODE) {
        status.textContent = tr('The file is too large to draw a waveform ({size}).', { size: fmtBytes(st.size) });
        info.textContent = fmtBytes(st.size);
        return;
      }
      try {
        const bytes = await invoke('viewers:readBytes', path);
        const head = sniffAudio(bytes.subarray(0, 1 << 20));
        const rate = head?.rate >= 3000 && head.rate <= 768000 ? head.rate : 48000;
        const seconds = await mediaDuration();
        const bytesPerSecond = (head?.channels || 2) * 4;
        let decodeRate = rate;
        if (Number.isFinite(seconds) && seconds * rate * bytesPerSecond > MAX_PCM) {
          decodeRate = Math.floor(MAX_PCM / (seconds * bytesPerSecond));
          if (decodeRate < 3000) {
            status.textContent = tr('The file is too large to draw a waveform ({size}).', { size: fmtBytes(st.size) });
            info.textContent = fmtBytes(st.size);
            return;
          }
        }
        if (disposed) return;
        host.dataset.decodeRate = String(decodeRate);
        const ctx = new OfflineAudioContext(1, 1, decodeRate);
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (disposed) return;
        duration = buf.duration;
        const lanes = Math.min(buf.numberOfChannels, 8);
        const BUCKETS = Math.min(buf.length, 16384);
        peaks = [];
        for (let c = 0; c < lanes; c++) {
          const data = buf.getChannelData(c);
          const out = new Float32Array(BUCKETS * 2);
          const per = data.length / BUCKETS;
          for (let i = 0; i < BUCKETS; i++) {
            let lo = 1;
            let hi = -1;
            const end = Math.min(data.length, Math.floor((i + 1) * per));
            for (let j = Math.floor(i * per); j < end; j++) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
            out[2 * i] = Math.max(-1, lo);
            out[2 * i + 1] = Math.min(1, hi);
          }
          peaks.push(out);
        }
        const channels = head?.channels || buf.numberOfChannels;
        // Without a header rate, the decoded rate is the file's own only when it was not lowered.
        const fileRate = head?.rate || (decodeRate === rate ? buf.sampleRate : 0);
        const parts = [
          ...(fileRate ? [`${fileRate.toLocaleString('en-US')} Hz`] : []),
          channels === 1 ? tr('Mono') : channels === 2 ? tr('Stereo') : tr('{n} channels', { n: channels }),
          ...(head?.bits ? [`${head.bits}-bit`] : []),
          fmtTime(buf.duration),
          fmtBytes(st.size),
        ];
        info.textContent = parts.join('  ·  ');
        host.dataset.sampleRate = String(fileRate || '');
        host.dataset.channels = String(channels);
        host.dataset.duration = String(buf.duration);
        host.dataset.loaded = 'true';
        status.textContent = '';
        readout();
        draw();
      } catch (e) {
        status.textContent = tr('Could not decode this audio file: {error}', { error: cleanError(e) });
        status.classList.add('error');
        info.textContent = fmtBytes(st.size);
      }
    }
    load();

    const ro = ide.util.observeSize(stage, () => draw());
    const offTheme = onTheme(draw);
    return {
      dispose: () => {
        disposed = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        offTheme();
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      },
    };
  }

  // ---------- small data table (arrays, tensors) ----------
  function dataTable(columns, rows, { index = true, startIndex = 0, cls = '' } = {}) {
    const table = user(el('table', `vw-table ${cls}`));
    const thead = el('thead');
    const hr = el('tr');
    if (index) hr.appendChild(el('th', 'vw-idx', ''));
    for (const c of columns) hr.appendChild(el('th', null, c));
    thead.appendChild(hr);
    const tbody = el('tbody');
    rows.forEach((r, i) => {
      const tr_ = el('tr');
      if (index) tr_.appendChild(el('td', 'vw-idx', String(startIndex + i)));
      for (const v of r) tr_.appendChild(el('td', null, v));
      tbody.appendChild(tr_);
    });
    table.append(thead, tbody);
    return table;
  }

  // Message shown when a Python probe could not run: no interpreter, missing module, timeout or an error.
  function probeProblem(r, { module, what }) {
    const box = el('div', 'vw-problem');
    if (r.noInterpreter) box.appendChild(el('div', null, tr('No Python interpreter is configured.')));
    else if (r.missing) {
      box.appendChild(el('div', null, tr('{module} is not installed in the selected interpreter.', { module })));
      box.appendChild(userEl('div', 'vw-muted', r.interp || ''));
      box.appendChild(el('div', 'vw-muted', what));
    } else if (r.timeout) box.appendChild(el('div', null, tr('Loading took too long and was stopped.')));
    else {
      box.appendChild(el('div', null, tr('Could not read the file.')));
      box.appendChild(userEl('pre', 'vw-error', r.error || ''));
    }
    return box;
  }

  // ---------- NumPy ----------
  function mountNumpy(host, { path }) {
    host.classList.add('vw', 'vw-numpy');
    const bar = toolbar();
    const title = userEl('span', 'vw-strong', basename(path));
    const size = userEl('span', 'vw-muted');
    const status = el('span', 'vw-status');
    const reload = button('⟳', tr('Reload'), () => load());
    bar.append(title, size, status, spacer(), reload);
    const body = el('div', 'vw-np-body');
    host.append(bar, body);
    invoke('viewers:stat', path).then((s) => { size.textContent = fmtBytes(s.size); }).catch(() => {});

    let arrays = [];
    let selected = 0;
    let disposed = false;
    let needsInterp = false;

    function details(a) {
      const pane = el('div', 'vw-np-detail');
      const head = el('div', 'vw-np-head');
      head.appendChild(userEl('span', 'vw-np-name', a.name));
      const meta = el('div', 'vw-kv');
      const kv = (k, v) => { meta.append(el('span', 'vw-k', k), userEl('span', 'vw-v', v)); };
      kv(tr('Shape'), fmtShape(a.shape));
      kv(tr('Data type'), a.dtype);
      if (a.size != null) kv(tr('Elements'), a.size.toLocaleString('en-US'));
      if (a.nbytes != null) kv(tr('Memory'), fmtBytes(a.nbytes));
      if (a.fortran) kv(tr('Order'), 'Fortran');
      pane.append(head, meta);
      if (a.stats) {
        const stats = el('div', 'vw-stats');
        const cell = (k, v) => { const c = el('div', 'vw-stat'); c.append(el('div', 'vw-k', k), userEl('div', 'vw-v', fmtNum(v))); stats.appendChild(c); };
        cell(tr('Min'), a.stats.min);
        cell(tr('Max'), a.stats.max);
        cell(tr('Mean'), a.stats.mean);
        cell(tr('Std'), a.stats.std);
        if (a.stats.nan) cell('NaN', a.stats.nan);
        if (a.stats.inf) cell('Inf', a.stats.inf);
        pane.appendChild(stats);
      }
      if (a.rows) {
        const notes = [];
        if (a.slice) notes.push(tr('Showing slice {slice}', { slice: a.slice }));
        if (a.truncatedRows || a.truncatedCols) notes.push(tr('Showing the first 200 rows and 50 columns'));
        if (notes.length) pane.appendChild(el('div', 'vw-note', notes.join(' · ')));
        const wrap = el('div', 'vw-table-wrap');
        wrap.appendChild(dataTable(a.columns, a.rows));
        pane.appendChild(wrap);
      } else if (a.lazy) pane.appendChild(el('div', 'vw-muted', tr('Loading…')));
      return pane;
    }

    function render() {
      body.replaceChildren();
      const npz = arrays.length > 1 || ext(path) === 'npz';
      let detailHost = body;
      if (npz) {
        const list = el('div', 'vw-np-list');
        list.appendChild(el('div', 'vw-list-title', tr('Arrays ({n})', { n: arrays.length })));
        arrays.forEach((a, i) => {
          const item = el('div', `vw-np-item${i === selected ? ' active' : ''}`);
          item.append(userEl('span', 'vw-np-item-name', a.name), userEl('span', 'vw-np-item-meta', `${fmtShape(a.shape)} ${a.dtype}`));
          item.onclick = () => select(i);
          list.appendChild(item);
        });
        detailHost = el('div', 'vw-np-right');
        body.append(list, detailHost);
      }
      if (arrays[selected]) detailHost.appendChild(details(arrays[selected]));
    }

    async function select(i) {
      selected = i;
      render();
      const a = arrays[i];
      if (!a?.lazy) return;
      const r = await probe('numpy', path, a.name);
      if (disposed) return;
      if (r.ok && r.arrays?.[0]) arrays[i] = r.arrays[0];
      else arrays[i] = { ...a, lazy: false, error: r.error };
      if (selected === i) render();
    }

    async function load() {
      status.textContent = tr('Loading arrays…');
      status.classList.remove('error');
      body.replaceChildren();
      const r = await probe('numpy', path);
      if (disposed) return;
      status.textContent = '';
      needsInterp = !!(r.missing || r.noInterpreter);
      if (!r.ok) {
        body.appendChild(probeProblem(r, { module: 'NumPy', what: tr('Install it from the Python Packages tool window, or choose another interpreter.') }));
        host.dataset.error = r.missing ? 'missing' : 'error';
        return;
      }
      arrays = r.arrays || [];
      selected = Math.min(selected, Math.max(0, arrays.length - 1));
      host.dataset.loaded = 'true';
      delete host.dataset.error;
      render();
    }
    load();
    const off = ide.on('interpreterChanged', () => { if (needsInterp) load(); });
    return { dispose: () => { disposed = true; off(); } };
  }

  // ---------- model files ----------
  const MODEL_EXT = ['pt', 'pth', 'ckpt', 'bin', 'onnx', 'safetensors', 'task', 'tflite', 'h5', 'keras'];
  const MODEL_KIND = {
    pt: 'PyTorch checkpoint', pth: 'PyTorch checkpoint', ckpt: 'Checkpoint', onnx: 'ONNX model', safetensors: 'safetensors',
    task: 'MediaPipe task bundle', tflite: 'TensorFlow Lite model', h5: 'HDF5 / Keras model', keras: 'Keras model', bin: 'PyTorch checkpoint',
  };

  async function readSafetensors(path) {
    const head = await invoke('viewers:readBytes', path, 0, 8);
    if (head.length < 8) throw new Error(tr('The file is too short to be a safetensors file.'));
    const n = Number(new DataView(head.buffer, head.byteOffset, 8).getBigUint64(0, true));
    if (!n || n > 100 * 1024 * 1024) throw new Error(tr('Invalid safetensors header length: {n}', { n }));
    const bytes = await invoke('viewers:readBytes', path, 8, n);
    const header = JSON.parse(new TextDecoder().decode(bytes));
    const meta = header.__metadata__ || null;
    delete header.__metadata__;
    const tensors = Object.entries(header).map(([name, t]) => ({
      name, dtype: t.dtype, shape: t.shape || [], numel: (t.shape || []).reduce((a, b) => a * b, 1),
    }));
    return { tensors, meta };
  }

  // Lists a zip archive's entries from its central directory (MediaPipe .task bundles are zips).
  async function readZipEntries(path, size) {
    const tailLen = Math.min(size, 66000);
    const tail = await invoke('viewers:readBytes', path, size - tailLen, tailLen);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);
    const cd = await invoke('viewers:readBytes', path, cdOff, Math.min(cdSize, 4 * 1024 * 1024));
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const out = [];
    for (let o = 0, i = 0; i < count && o + 46 <= cd.length && cv.getUint32(o, true) === 0x02014b50; i++) {
      const nameLen = cv.getUint16(o + 28, true);
      out.push({ name: new TextDecoder().decode(cd.subarray(o + 46, o + 46 + nameLen)), size: cv.getUint32(o + 24, true) });
      o += 46 + nameLen + cv.getUint16(o + 30, true) + cv.getUint16(o + 32, true);
    }
    return out;
  }

  function tensorTable(list) {
    const box = el('div', 'vw-tensors');
    const filterRow = el('div', 'vw-filter-row');
    const filter = el('input', 'vw-input');
    filter.placeholder = tr('Filter tensors');
    const count = el('span', 'vw-muted');
    filterRow.append(filter, count);
    const wrap = el('div', 'vw-table-wrap');
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = (q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list).slice(0, 5000);
      count.textContent = tr('{shown} of {total} tensors', { shown: shown.length, total: list.length });
      wrap.replaceChildren(dataTable([tr('Name'), tr('Data type'), tr('Shape'), tr('Parameters')],
        shown.map((t) => [t.name, t.dtype, fmtShape(t.shape), t.numel.toLocaleString('en-US')]), { index: false, cls: 'vw-tensor-table' }));
    };
    filter.oninput = debounce(render, 120);
    render();
    box.append(filterRow, wrap);
    return box;
  }

  function summaryOf(list) {
    const params = list.reduce((a, t) => a + t.numel, 0);
    const byType = {};
    for (const t of list) byType[t.dtype] = (byType[t.dtype] || 0) + t.numel;
    return { params, byType };
  }

  function mountModel(host, { path }) {
    host.classList.add('vw', 'vw-model');
    const e = ext(path);
    const scroll = el('div', 'vw-scroll');
    const card = el('div', 'vw-card');
    const top = el('div', 'vw-card-head');
    top.append(el('span', 'vw-card-icon', '🧠'), userEl('span', 'vw-card-title', basename(path)), el('span', 'vw-badge', tr(MODEL_KIND[e] || 'Model file')));
    const kv = el('div', 'vw-kv');
    const row = (k, v) => { kv.append(el('span', 'vw-k', k), userEl('span', 'vw-v', v)); };
    const actions = el('div', 'vw-actions');
    const copied = el('span', 'vw-status');
    actions.append(
      button(tr('Copy Path'), null, async () => { await invoke('clipboard:writeText', path); copied.textContent = tr('Copied'); setTimeout(() => (copied.textContent = ''), 1500); }, 'secondary vw-copy-path'),
      button(tr('Show in Explorer'), null, () => invoke('shell:showInFolder', path), 'secondary'),
      copied,
    );
    card.append(top, kv, actions);
    const details = el('div', 'vw-model-details');
    scroll.append(card, details);
    host.appendChild(scroll);
    let disposed = false;

    const section = (title) => { const s = el('div', 'vw-section'); s.appendChild(el('div', 'vw-section-title', title)); details.appendChild(s); return s; };
    const statusLine = (text) => { const s = el('div', 'vw-muted vw-pad', text); details.appendChild(s); return s; };
    const summarize = (s, list) => {
      const { params, byType } = summaryOf(list);
      const k = el('div', 'vw-kv');
      k.append(el('span', 'vw-k', tr('Tensors')), userEl('span', 'vw-v', list.length.toLocaleString('en-US')));
      k.append(el('span', 'vw-k', tr('Parameters')), userEl('span', 'vw-v vw-params', fmtCount(params)));
      k.append(el('span', 'vw-k', tr('Data types')), userEl('span', 'vw-v', Object.entries(byType).map(([d, n]) => `${d}: ${fmtCount(n)}`).join(', ')));
      s.appendChild(k);
    };

    async function load() {
      let st;
      try { st = await invoke('viewers:stat', path); } catch (err) { statusLine(cleanError(err)); return; }
      row(tr('Path'), path);
      row(tr('Size'), st.size < 1024 ? fmtBytes(st.size) : `${fmtBytes(st.size)} (${st.size.toLocaleString('en-US')} B)`);
      row(tr('Modified'), new Date(st.mtime).toLocaleString());
      host.dataset.loaded = 'true';

      if (e === 'safetensors') {
        try {
          const { tensors, meta } = await readSafetensors(path);
          const s = section(tr('Tensors'));
          summarize(s, tensors);
          if (meta) {
            const m = el('div', 'vw-kv vw-meta');
            for (const [k, v] of Object.entries(meta)) m.append(userEl('span', 'vw-k', k), userEl('span', 'vw-v', String(v)));
            s.append(el('div', 'vw-subtitle', tr('Metadata')), m);
          }
          s.appendChild(tensorTable(tensors));
          host.dataset.tensors = String(tensors.length);
        } catch (err) { statusLine(tr('Could not read the safetensors header: {error}', { error: cleanError(err) })); }
      } else if (e === 'onnx') {
        const wait = statusLine(tr('Reading the model with onnx…'));
        const r = await probe('onnx', path);
        if (disposed) return;
        wait.remove();
        if (!r.ok) {
          details.appendChild(probeProblem(r, { module: 'onnx', what: tr('Inputs, outputs and the opset are shown when the onnx package is available.') }));
          host.dataset.probe = r.missing ? 'missing' : 'error';
          return;
        }
        const s = section(tr('Graph'));
        const k = el('div', 'vw-kv');
        const add = (a, b) => k.append(el('span', 'vw-k', a), userEl('span', 'vw-v', b));
        add(tr('Opset'), r.opset.map((o) => `${o.domain} ${o.version}`).join(', '));
        add(tr('IR version'), String(r.irVersion));
        if (r.producer) add(tr('Producer'), r.producer);
        add(tr('Nodes'), r.nodes.toLocaleString('en-US'));
        add(tr('Parameters'), fmtCount(r.params));
        if (r.ops?.length) add(tr('Operators'), r.ops.map(([op, n]) => `${op} ×${n}`).join(', '));
        s.appendChild(k);
        const io = (title, list) => {
          const t = section(title);
          t.appendChild(dataTable([tr('Name'), tr('Data type'), tr('Shape')], list.map((v) => [v.name, v.dtype, v.shape ? `[${v.shape.join(', ')}]` : '?']), { index: false }));
        };
        io(tr('Inputs'), r.inputs);
        io(tr('Outputs'), r.outputs);
        host.dataset.probe = 'ok';
      } else if (['pt', 'pth', 'ckpt', 'bin'].includes(e)) {
        const wait = statusLine(tr('Loading with torch (weights only)…'));
        const r = await probe('torch', path);
        if (disposed) return;
        wait.remove();
        if (!r.ok) {
          details.appendChild(probeProblem(r, { module: 'PyTorch', what: tr('Only the file information is shown.') }));
          host.dataset.probe = r.missing ? 'missing' : 'error';
          return;
        }
        const s = section(tr('State dict'));
        summarize(s, r.tensors);
        if (r.truncated) s.appendChild(el('div', 'vw-note', tr('Only the first 5000 tensors are listed.')));
        s.appendChild(tensorTable(r.tensors));
        if (r.other?.length) {
          const o = section(tr('Other entries'));
          o.appendChild(dataTable([tr('Name'), tr('Type'), tr('Value')], r.other.map((x) => [x.name, x.type, x.value]), { index: false }));
        }
        host.dataset.tensors = String(r.tensors.length);
        host.dataset.probe = 'ok';
      } else if (e === 'task') {
        const entries = await readZipEntries(path, st.size).catch(() => null);
        if (!entries) { statusLine(tr('This file is not a zip bundle.')); return; }
        const s = section(tr('Bundle contents'));
        s.appendChild(dataTable([tr('Name'), tr('Size')], entries.map((x) => [x.name, fmtBytes(x.size)]), { index: false }));
      } else if (e === 'tflite') {
        const b = await invoke('viewers:readBytes', path, 0, 8);
        const id = String.fromCharCode(...b.subarray(4, 8));
        statusLine(id === 'TFL3' ? tr('TensorFlow Lite flatbuffer (TFL3).') : tr('No TensorFlow Lite identifier found.'));
      } else if (e === 'h5' || e === 'keras') {
        const b = await invoke('viewers:readBytes', path, 0, 8);
        const hdf = b[0] === 0x89 && String.fromCharCode(...b.subarray(1, 4)) === 'HDF';
        const zip = b[0] === 0x50 && b[1] === 0x4b;
        statusLine(hdf ? tr('HDF5 file.') : zip ? tr('Zip archive (Keras 3 format).') : tr('Unknown file signature.'));
      }
    }
    load();
    return { dispose: () => { disposed = true; } };
  }

  // ---------- embedded editor + mode toolbar shared by text viewers ----------
  // The theme is passed explicitly: Monaco themes are global, and the shared editor options still name the startup
  // theme, which would switch every editor back to dark in a Light session.
  function embedEditor(host, doc) {
    const theme = document.documentElement.dataset.theme === 'light' ? 'pycharm-light' : 'pycharm-dark';
    return ide.createEditor(host, { model: doc.model, automaticLayout: true, theme });
  }

  // ---------- Markdown ----------
  let markedLoad = null;
  // marked's UMD wrapper registers with Monaco's AMD loader when it sees define.amd, so only that flag is hidden while
  // the script loads (Monaco keeps calling define() for languages it loads lazily in the meantime).
  function loadMarked() {
    if (window.marked) return Promise.resolve(window.marked);
    markedLoad ||= new Promise((resolve, reject) => {
      const amd = window.define?.amd;
      if (window.define) window.define.amd = undefined;
      const restore = () => { if (window.define && amd) window.define.amd = amd; };
      const s = document.createElement('script');
      s.src = '../node_modules/marked/marked.min.js';
      s.onload = () => { restore(); resolve(window.marked); };
      s.onerror = () => { restore(); markedLoad = null; reject(new Error('marked.min.js failed to load')); };
      document.head.appendChild(s);
    });
    return markedLoad;
  }

  // SVG animations can set an attribute (a link's href) after the sanitizer looked at it.
  const BLOCKED = 'script,style,iframe,frame,frameset,object,embed,applet,link,meta,base,form,input,button,textarea,select,option,noscript,template,portal,animate,set,animateMotion,animateTransform';
  const hasScheme = (u) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) && !/^[a-zA-Z]:[\\/]/.test(u);
  const safeHref = (u) => /^https?:\/\//i.test(u) || u.startsWith('#') || !hasScheme(u);

  // Strips scripts, event handlers and non-http(s) links; resolves relative images against the document's folder.
  function sanitizeInto(html, baseDir) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (const n of tpl.content.querySelectorAll(BLOCKED)) n.remove();
    for (const n of tpl.content.querySelectorAll('*')) {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || ['srcdoc', 'formaction', 'srcset', 'action', 'style', 'xlink:href'].includes(name)) n.removeAttribute(a.name);
      }
      if (n.hasAttribute('href')) {
        const h = n.getAttribute('href').trim();
        if (!safeHref(h)) { n.removeAttribute('href'); n.classList.add('vw-md-dead-link'); }
      }
      if (n.hasAttribute('src')) {
        const s = n.getAttribute('src').trim();
        if (n.tagName !== 'IMG' && n.tagName !== 'VIDEO' && n.tagName !== 'AUDIO' && n.tagName !== 'SOURCE') n.removeAttribute('src');
        else if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) { /* allowed as is */ } else if (hasScheme(s)) n.removeAttribute('src');
        else {
          const p = resolveRel(baseDir, s);
          if (p) n.setAttribute('src', fileUrl(p)); else n.removeAttribute('src');
        }
      }
    }
    return tpl.content;
  }

  const slug = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  const MD_LANG = { py: 'python', python: 'python', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript',
    json: 'json', jsonc: 'json', sh: 'shell', bash: 'shell', shell: 'shell', ps1: 'powershell', powershell: 'powershell', toml: 'ini',
    ini: 'ini', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', sql: 'sql', xml: 'xml', cpp: 'cpp', c: 'c', rust: 'rust', go: 'go', java: 'java' };

  // Renders Markdown into `target`; every top-level block carries data-line (0-based source line) for scroll sync.
  function renderMarkdown(target, text, baseDir) {
    const marked = window.marked;
    const tokens = marked.lexer(text, { gfm: true });
    const frag = document.createDocumentFragment();
    let line = 0;
    for (const tok of tokens) {
      const start = line;
      line += (tok.raw.match(/\n/g) || []).length;
      if (tok.type === 'space') continue;
      const sub = [tok];
      sub.links = tokens.links;
      const nodes = sanitizeInto(marked.parser(sub, { gfm: true }), baseDir);
      for (const n of nodes.children) n.dataset.line = String(start);
      frag.appendChild(nodes);
    }
    const ids = new Map();
    for (const h of frag.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const base = slug(h.textContent) || 'section';
      const n = ids.get(base) || 0;
      ids.set(base, n + 1);
      h.id = n ? `${base}-${n}` : base;
    }
    for (const code of frag.querySelectorAll('pre > code[class*="language-"]')) {
      const lang = MD_LANG[(code.className.match(/language-([\w+-]+)/) || [])[1]?.toLowerCase()];
      if (!lang) continue;
      monaco.editor.colorize(code.textContent, lang, { tabSize: 4 }).then((html) => { if (code.isConnected) code.innerHTML = html; }).catch(() => {});
    }
    target.replaceChildren(frag);
  }

  function mountMarkdown(host, { path, doc }) {
    host.classList.add('vw', 'vw-md');
    if (!doc) { host.classList.add('vw-center'); fallbackCard(host, path, tr('This file is too large to edit.')); return {}; }
    const baseDir = dirname(path);
    const MODES = [
      { value: 'editor', label: tr('Editor'), title: tr('Show Editor Only') },
      { value: 'split', label: tr('Editor and Preview'), title: tr('Show Editor and Preview') },
      { value: 'preview', label: tr('Preview'), title: tr('Show Preview Only') },
    ];
    let mode = ide.settings.get('viewers.markdownMode', 'split');
    const bar = toolbar();
    const seg = segmented(MODES, mode, (v) => setMode(v, true));
    const syncBtn = button('⇅', tr('Synchronize Scrolling'), () => {
      syncScroll = !syncScroll;
      syncBtn.classList.toggle('active', syncScroll);
      ide.settings.set('viewers.markdownSyncScroll', syncScroll);
    }, 'vw-btn vw-toggle');
    let syncScroll = ide.settings.get('viewers.markdownSyncScroll', true);
    syncBtn.classList.toggle('active', syncScroll);
    const status = el('span', 'vw-status');
    bar.append(seg.el, syncBtn, status);
    const split = el('div', 'vw-md-split');
    const edHost = el('div', 'vw-md-editor');
    const divider = el('div', 'vw-md-divider');
    // The rendered document is user content.
    const preview = userEl('div', 'vw-md-preview vw-markdown');
    preview.tabIndex = -1;
    split.append(edHost, divider, preview);
    host.append(bar, split);

    const editor = embedEditor(edHost, doc);
    let ratio = 0.5;
    let disposed = false;
    let rendered = false;

    function setMode(v, persist) {
      mode = v;
      seg.set(v);
      host.dataset.mode = v;
      edHost.classList.toggle('hidden', v === 'preview');
      preview.classList.toggle('hidden', v === 'editor');
      divider.classList.toggle('hidden', v !== 'split');
      edHost.style.flex = v === 'split' ? `${ratio} 1 0` : '1 1 0';
      preview.style.flex = v === 'split' ? `${1 - ratio} 1 0` : '1 1 0';
      syncBtn.classList.toggle('hidden', v !== 'split');
      if (persist) ide.settings.set('viewers.markdownMode', v);
      if (v !== 'editor' && !rendered) update();
      if (v !== 'preview') editor.layout();
    }

    const update = async () => {
      if (disposed || mode === 'editor') return;
      try { await loadMarked(); } catch (e) { status.textContent = cleanError(e); return; }
      if (disposed) return;
      const keep = preview.scrollTop;
      renderMarkdown(preview, doc.model.getValue(), baseDir);
      rendered = true;
      host.dataset.renders = String(Number(host.dataset.renders || 0) + 1);
      if (mode === 'split' && syncScroll) editorToPreview(); else preview.scrollTop = keep;
    };
    const scheduled = debounce(update, 150);
    const sub = doc.model.onDidChangeContent(() => { rendered = false; scheduled(); });

    // ----- synchronized scrolling (editor <-> preview), interpolated between source-mapped blocks -----
    let lockUntil = 0;
    let lockBy = null;
    const lock = (by) => { lockBy = by; lockUntil = performance.now() + 120; };
    const locked = (by) => lockBy && lockBy !== by && performance.now() < lockUntil;
    const blocks = () => [...preview.children].filter((n) => n.dataset.line !== undefined).map((n) => ({ line: Number(n.dataset.line), top: n.offsetTop }));
    const lineHeight = () => editor.getOption(monaco.editor.EditorOption.lineHeight);
    function editorTopLine() {
      const first = editor.getVisibleRanges()[0]?.startLineNumber || 1;
      const frac = (editor.getScrollTop() - editor.getTopForLineNumber(first)) / lineHeight();
      return first - 1 + Math.max(0, Math.min(1, frac));
    }
    function editorToPreview() {
      if (mode !== 'split' || !syncScroll || locked('editor')) return;
      const max = editor.getScrollHeight() - editor.getLayoutInfo().height;
      lock('editor');
      if (max > 0 && editor.getScrollTop() >= max - 2) { preview.scrollTop = preview.scrollHeight; return; }
      const L = editorTopLine();
      const bs = blocks();
      if (!bs.length) return;
      let i = bs.findIndex((b) => b.line > L) - 1;
      if (i === -2) i = bs.length - 1;
      if (i < 0) { preview.scrollTop = 0; return; }
      const a = bs[i];
      const b = bs[i + 1];
      const y = b ? a.top + ((b.top - a.top) * (L - a.line)) / Math.max(1, b.line - a.line) : a.top + (L - a.line) * lineHeight();
      preview.scrollTop = Math.max(0, y - 12);
    }
    function previewToEditor() {
      if (mode !== 'split' || !syncScroll || locked('preview')) return;
      lock('preview');
      if (preview.scrollTop >= preview.scrollHeight - preview.clientHeight - 2) { editor.setScrollTop(editor.getScrollHeight()); return; }
      const y = preview.scrollTop + 12;
      const bs = blocks();
      if (!bs.length) return;
      let i = bs.findIndex((b) => b.top > y) - 1;
      if (i === -2) i = bs.length - 1;
      if (i < 0) { editor.setScrollTop(0); return; }
      const a = bs[i];
      const b = bs[i + 1];
      const L = b ? a.line + ((b.line - a.line) * (y - a.top)) / Math.max(1, b.top - a.top) : a.line;
      editor.setScrollTop(editor.getTopForLineNumber(Math.floor(L) + 1) + (L % 1) * lineHeight());
    }
    const scrollSub = editor.onDidScrollChange((e) => { if (e.scrollTopChanged) editorToPreview(); });
    preview.addEventListener('scroll', previewToEditor);

    // Links: http(s) open in the browser, anchors scroll, relative files open in the IDE.
    // An image map's <area> is a link too; left to itself it would navigate the IDE window.
    preview.addEventListener('click', async (e) => {
      const a = e.target.closest('a, area');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#')) {
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch {}
        preview.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
      } else if (/^https?:\/\//i.test(href)) invoke('viewers:openExternal', href);
      else {
        const p = resolveRel(baseDir, href);
        if (p && await ide.api.exists(p)) ide.openFile(p);
      }
    });

    divider.addEventListener('mousedown', (down) => {
      down.preventDefault();
      const r = split.getBoundingClientRect();
      const move = (e) => {
        ratio = Math.min(0.85, Math.max(0.15, (e.clientX - r.left) / r.width));
        edHost.style.flex = `${ratio} 1 0`;
        preview.style.flex = `${1 - ratio} 1 0`;
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    // Activating the tab focuses the host; hand focus to the editor when it is visible.
    host.addEventListener('focus', () => { if (mode !== 'preview') editor.focus(); else preview.focus(); });

    setMode(mode);
    host._viewer = { editor, setMode, preview };
    return {
      dispose: () => {
        disposed = true;
        scheduled.cancel();
        sub.dispose();
        scrollSub.dispose();
        editor.dispose();
      },
    };
  }

  // ---------- HTML ----------
  // The page renders in a sandboxed iframe served by main/features/viewers.js (pyide-preview://), so linked stylesheets,
  // scripts and images load from the project as on a web server, with unsaved editor text standing in for the file on
  // disk. Typing in the page or in any open CSS/JS/SVG/JSON file of the same site reloads it at the same scroll.
  const PREVIEW_RELOAD_EXT = new Set(['html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'json', 'svg']);
  const previewWidths = () => [['', tr('Responsive')], ['1280', tr('Desktop (1280 px)')], ['768', tr('Tablet (768 px)')], ['375', tr('Mobile (375 px)')]];

  function mountHtml(host, { path, doc }) {
    host.classList.add('vw', 'vw-md', 'vw-html');
    if (!doc) { host.classList.add('vw-center'); fallbackCard(host, path, tr('This file is too large to edit.')); return {}; }
    const MODES = [
      { value: 'editor', label: tr('Editor'), title: tr('Show Editor Only') },
      { value: 'split', label: tr('Editor and Preview'), title: tr('Show Editor and Preview') },
      { value: 'preview', label: tr('Preview'), title: tr('Show Preview Only') },
    ];
    let mode = ide.settings.get('viewers.htmlMode', 'split');
    const bar = toolbar();
    const seg = segmented(MODES, mode, (v) => setMode(v, true));
    const reloadBtn = button('⟳', tr('Reload Preview'), () => reload());
    const width = el('select', 'vw-html-width');
    width.title = tr('Preview width');
    for (const [v, label] of previewWidths()) width.add(new Option(label, v));
    width.value = ide.settings.get('viewers.htmlWidth', '');
    width.onchange = () => { ide.settings.set('viewers.htmlWidth', width.value); applyWidth(); };
    const browserBtn = button(tr('Open in Browser'), tr('Open the saved file in the system browser'), () => invoke('viewers:openInBrowser', path));
    const status = el('span', 'vw-status vw-html-errors');
    bar.append(seg.el, reloadBtn, width, browserBtn, status);
    const split = el('div', 'vw-md-split');
    const edHost = el('div', 'vw-md-editor');
    const divider = el('div', 'vw-md-divider');
    const stage = el('div', 'vw-html-stage');
    const frame = el('iframe', 'vw-html-frame');
    // No allow-same-origin: the page runs in its own opaque origin and cannot reach the IDE.
    frame.sandbox = 'allow-scripts allow-forms allow-modals allow-popups';
    frame.title = tr('HTML preview');
    stage.appendChild(frame);
    split.append(edHost, divider, stage);
    host.append(bar, split);

    const editor = embedEditor(edHost, doc);
    let ratio = 0.5;
    let disposed = false;
    let url = null;
    let root = null;
    let scrollY = 0;
    let errors = [];

    function applyWidth() {
      const w = Number(width.value);
      frame.style.width = w ? `${w}px` : '100%';
      stage.classList.toggle('fixed', !!w);
    }
    function renderStatus() {
      status.textContent = errors.length ? tr(errors.length === 1 ? '{n} script error' : '{n} script errors', { n: errors.length }) : '';
      status.title = errors.map((e) => `${e.message}${e.source ? ` (${e.source.split('/').pop()}:${e.line})` : ''}`).join('\n');
    }
    function setMode(v, persist) {
      mode = v;
      seg.set(v);
      host.dataset.mode = v;
      edHost.classList.toggle('hidden', v === 'preview');
      stage.classList.toggle('hidden', v === 'editor');
      divider.classList.toggle('hidden', v !== 'split');
      edHost.style.flex = v === 'split' ? `${ratio} 1 0` : '1 1 0';
      stage.style.flex = v === 'split' ? `${1 - ratio} 1 0` : '1 1 0';
      if (persist) ide.settings.set('viewers.htmlMode', v);
      if (v !== 'editor' && !frame.src) reload();
      if (v !== 'preview') editor.layout();
    }

    const openDocs = () => ide.groups().flatMap((g) => g.tabs).filter((t) => t.doc && t.path);
    async function reload() {
      if (disposed || mode === 'editor') return;
      if (!url) ({ url, root } = await invoke('viewers:previewUrl', path, ide.root));
      const unsaved = {};
      for (const t of openDocs()) if (ide.isDirty(t) && ide.util.isUnder(t.path, root)) unsaved[t.path] = t.doc.model.getValue();
      await invoke('viewers:previewOverrides', new URL(url).hostname, unsaved);
      if (disposed) return;
      errors = [];
      renderStatus();
      frame.src = `${url}?__pyide_t=${Date.now()}&__pyide_y=${Math.round(scrollY)}`;
      host.dataset.reloads = String(Number(host.dataset.reloads || 0) + 1);
    }
    const scheduled = debounce(reload, 300);
    const affects = (p) => root && ide.util.isUnder(p, root) && PREVIEW_RELOAD_EXT.has(p.split('.').pop().toLowerCase());
    const subs = [doc.model.onDidChangeContent(() => scheduled())];
    // Edits to the site's other open files (a stylesheet in another tab) reload the page too.
    const watchModel = (m) => {
      if (m === doc.model) return;
      subs.push(m.onDidChangeContent(() => {
        const t = openDocs().find((x) => x.doc.model === m);
        if (t && affects(t.path)) scheduled();
      }));
    };
    monaco.editor.getModels().forEach(watchModel);
    subs.push(monaco.editor.onDidCreateModel(watchModel));
    const onDisk = (c = {}) => {
      const paths = [...(c.created || []), ...(c.deleted || []), ...(c.changed || []), ...(c.renamed || []).flat()];
      if (!paths.length || paths.some(affects)) scheduled();
    };
    const offSaved = ide.on('fileSaved', (t) => { if (t?.path && affects(t.path)) scheduled(); });
    const offChanged = ide.on('filesChanged', onDisk);

    const onMessage = (e) => {
      if (e.source !== frame.contentWindow || !e.data?.pyidePreview) return;
      const m = e.data;
      if (m.type === 'scroll') scrollY = Number(m.y) || 0;
      else if (m.type === 'error') { errors.push({ message: String(m.message), source: String(m.source || ''), line: Number(m.line) || 0 }); renderStatus(); }
      else if (m.type === 'open' && /^https?:\/\//i.test(m.url)) invoke('viewers:openExternal', m.url);
    };
    addEventListener('message', onMessage);

    divider.addEventListener('mousedown', (down) => {
      down.preventDefault();
      const r = split.getBoundingClientRect();
      // The iframe would swallow mouse moves while dragging over it.
      frame.style.pointerEvents = 'none';
      const move = (e) => {
        ratio = Math.min(0.85, Math.max(0.15, (e.clientX - r.left) / r.width));
        edHost.style.flex = `${ratio} 1 0`;
        stage.style.flex = `${1 - ratio} 1 0`;
      };
      const up = () => { frame.style.pointerEvents = ''; removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    host.addEventListener('focus', () => { if (mode !== 'preview') editor.focus(); });

    applyWidth();
    setMode(mode);
    host._viewer = { editor, setMode, frame, reload, errors: () => errors };
    return {
      dispose: () => {
        disposed = true;
        scheduled.cancel();
        subs.forEach((s) => s.dispose());
        offSaved?.();
        offChanged?.();
        removeEventListener('message', onMessage);
        editor.dispose();
      },
    };
  }

  // ---------- CSV / TSV / JSONL tables ----------
  // RFC 4180: quoted fields with "" escapes and embedded newlines; records remember their 1-based start line.
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let atStart = true;
    let line = 1;
    let rowLine = 1;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else {
          if (c === '\n') line++;
          field += c;
        }
        continue;
      }
      if (c === '"' && atStart) { quoted = true; atStart = false; continue; }
      if (c === delim) { row.push(field); field = ''; atStart = true; continue; }
      if (c === '\r') continue;
      if (c === '\n') {
        row.push(field);
        if (row.length > 1 || row[0] !== '') { row.line = rowLine; rows.push(row); }
        row = [];
        field = '';
        atStart = true;
        line++;
        rowLine = line;
        continue;
      }
      field += c;
      atStart = false;
    }
    if (field !== '' || row.length) { row.push(field); row.line = rowLine; rows.push(row); }
    return rows;
  }

  function sniffDelimiter(text, path) {
    if (ext(path) === 'tsv') return '\t';
    const nl = text.indexOf('\n');
    const first = text.slice(0, nl < 0 ? 4096 : nl).replace(/"[^"]*"/g, '');
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  function tableFromCsv(text, path) {
    const rows = parseDelimited(text, sniffDelimiter(text, path));
    const header = rows.shift() || [];
    const width = Math.max(header.length, ...rows.slice(0, 5000).map((r) => r.length));
    const columns = Array.from({ length: width }, (_, i) => header[i] ?? String(i + 1));
    return { columns, rows: rows.map((r) => ({ cells: r, line: r.line, ragged: r.length !== header.length })), errors: 0 };
  }

  function tableFromJsonl(text) {
    const columns = [];
    const index = new Map();
    const rows = [];
    let errors = 0;
    const lines = text.split('\n');
    const cellText = (v) => (v === undefined ? '' : typeof v === 'string' ? v : (s => (s.length > 300 ? `${s.slice(0, 299)}…` : s))(JSON.stringify(v)));
    lines.forEach((raw, i) => {
      const lineText = raw.replace(/\r$/, '');
      if (!lineText.trim()) return;
      let obj;
      try { obj = JSON.parse(lineText); } catch (e) {
        errors++;
        rows.push({ line: i + 1, error: e.message, raw: lineText });
        return;
      }
      const rec = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { value: obj };
      for (const k of Object.keys(rec)) {
        if (!index.has(k) && columns.length < 200) { index.set(k, columns.length); columns.push(k); }
      }
      const cells = new Array(columns.length).fill('');
      for (const [k, v] of Object.entries(rec)) if (index.has(k)) cells[index.get(k)] = cellText(v);
      rows.push({ line: i + 1, cells });
    });
    return { columns, rows, errors };
  }

  // Virtualized grid: sticky header, sortable columns, column filter; renders only the rows in view.
  const ROW_H = 24;
  function createGrid(onOpenLine) {
    const scroller = el('div', 'vw-grid');
    scroller.tabIndex = 0;
    const head = el('div', 'vw-grid-head');
    const body = el('div', 'vw-grid-body');
    user(body);
    scroller.append(head, body);
    let data = { columns: [], rows: [] };
    let view = [];
    let widths = [];
    let sort = { col: -1, dir: 0 };
    let filter = { col: -1, text: '' };
    let selectedRow = -1;
    const numCache = new Map();

    function measure() {
      const sample = data.rows.slice(0, 300);
      widths = data.columns.map((c, i) => {
        let len = String(c).length + 2;
        for (const r of sample) if (r.cells) len = Math.max(len, Math.min(60, (r.cells[i] || '').length));
        return Math.max(56, Math.min(420, Math.round(len * 7.6 + 18)));
      });
      const idxW = Math.max(44, String(data.rows.at(-1)?.line || 0).length * 8 + 20);
      widths.unshift(idxW);
    }
    const totalWidth = () => widths.reduce((a, b) => a + b, 0);

    function renderHead() {
      head.replaceChildren();
      head.style.width = `${totalWidth()}px`;
      const idx = el('div', 'vw-cell vw-idx', '#');
      idx.style.width = `${widths[0]}px`;
      head.appendChild(idx);
      data.columns.forEach((c, i) => {
        const cell = el('div', 'vw-cell vw-th');
        cell.style.width = `${widths[i + 1]}px`;
        cell.appendChild(userEl('span', 'vw-th-name', c));
        if (sort.col === i) cell.appendChild(el('span', 'vw-sort', sort.dir > 0 ? '▲' : '▼'));
        cell.title = tr('Click to sort');
        cell.onclick = () => {
          if (sort.col !== i) sort = { col: i, dir: 1 };
          else sort = sort.dir === 1 ? { col: i, dir: -1 } : { col: -1, dir: 0 };
          recompute();
        };
        head.appendChild(cell);
      });
    }

    function numeric(col) {
      if (numCache.has(col)) return numCache.get(col);
      const nums = data.rows.map((r) => {
        const s = r.cells?.[col];
        if (s == null || s.trim() === '') return null;
        const v = Number(s);
        return Number.isFinite(v) ? v : NaN;
      });
      const allNumeric = nums.every((v) => v === null || !Number.isNaN(v));
      const res = allNumeric ? nums : null;
      numCache.set(col, res);
      return res;
    }

    function recompute() {
      const q = filter.text.trim().toLowerCase();
      view = [];
      for (let i = 0; i < data.rows.length; i++) {
        const r = data.rows[i];
        if (q) {
          const hay = r.error ? r.raw : filter.col < 0 ? r.cells.join('\u0001') : r.cells[filter.col] || '';
          if (!hay.toLowerCase().includes(q)) continue;
        }
        view.push(i);
      }
      if (sort.col >= 0) {
        const col = sort.col;
        const nums = numeric(col);
        const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        view.sort((a, b) => {
          const ra = data.rows[a];
          const rb = data.rows[b];
          if (ra.error || rb.error) return (ra.error ? 1 : 0) - (rb.error ? 1 : 0) || a - b;
          let c;
          if (nums) {
            const x = nums[a];
            const y = nums[b];
            if (x === null || y === null) return (x === null) - (y === null) || a - b;
            c = x - y;
          } else {
            const x = ra.cells[col] || '';
            const y = rb.cells[col] || '';
            if (!x || !y) return (!x) - (!y) || a - b;
            c = coll.compare(x, y);
          }
          return c * sort.dir || a - b;
        });
      }
      body.style.height = `${view.length * ROW_H}px`;
      body.style.width = `${totalWidth()}px`;
      renderHead();
      paint(true);
      grid.onChange?.();
    }

    let painted = { first: -1, last: -1 };
    function paint(force) {
      const headH = head.offsetHeight || ROW_H;
      const top = Math.max(0, scroller.scrollTop - headH);
      const first = Math.max(0, Math.floor(top / ROW_H) - 8);
      const last = Math.min(view.length, Math.ceil((top + scroller.clientHeight) / ROW_H) + 8);
      if (!force && first === painted.first && last === painted.last) return;
      painted = { first, last };
      const frag = document.createDocumentFragment();
      for (let v = first; v < last; v++) {
        const i = view[v];
        const r = data.rows[i];
        const rowEl = el('div', `vw-row${r.error ? ' vw-row-error' : ''}${r.ragged ? ' vw-row-ragged' : ''}${i === selectedRow ? ' selected' : ''}${v % 2 ? ' odd' : ''}`);
        rowEl.style.top = `${v * ROW_H}px`;
        rowEl.dataset.index = String(i);
        const idx = el('div', 'vw-cell vw-idx', String(r.line));
        idx.style.width = `${widths[0]}px`;
        rowEl.appendChild(idx);
        if (r.error) {
          const msg = el('div', 'vw-cell vw-error-cell');
          msg.style.width = `${totalWidth() - widths[0]}px`;
          msg.append(el('span', 'vw-error-label', tr('Line {line}: {error}', { line: r.line, error: r.error })), el('span', 'vw-error-raw', r.raw));
          rowEl.appendChild(msg);
        } else {
          for (let c = 0; c < data.columns.length; c++) {
            const cell = el('div', 'vw-cell', (r.cells[c] ?? '').replace(/\r?\n/g, '↵'));
            cell.style.width = `${widths[c + 1]}px`;
            rowEl.appendChild(cell);
          }
        }
        frag.appendChild(rowEl);
      }
      body.replaceChildren(frag);
    }

    // Painted synchronously: paint() is cheap when the visible window has not changed, and rAF stalls in hidden windows.
    scroller.addEventListener('scroll', () => paint(false));
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.vw-row');
      if (!row) return;
      selectedRow = Number(row.dataset.index);
      paint(true);
    });
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.vw-row');
      if (row) onOpenLine(data.rows[Number(row.dataset.index)].line);
    });
    const ro = ide.util.observeSize(scroller, () => paint(true));

    const grid = {
      el: scroller,
      set(d) {
        const sameColumns = d.columns.join('\u0001') === data.columns.join('\u0001');
        data = d;
        numCache.clear();
        if (!sameColumns) { sort = { col: -1, dir: 0 }; if (filter.col >= d.columns.length) filter.col = -1; }
        measure();
        recompute();
      },
      setFilter(col, text) { filter = { col, text }; recompute(); },
      get shown() { return view.length; },
      get total() { return data.rows.length; },
      get columns() { return data.columns; },
      dispose() { ro.disconnect(); },
      onChange: null,
    };
    return grid;
  }

  // Editor / Table views of a text document. `build(text)` -> {columns, rows, errors}.
  const MAX_TABLE_BYTES = 32 * 1024 * 1024;
  function mountTableViewer(host, { path, doc }, { kind, build }) {
    host.classList.add('vw', 'vw-tableview');
    const settingKey = `viewers.${kind}Mode`;
    let mode = doc ? ide.settings.get(settingKey, 'table') : 'table';
    const bar = toolbar();
    const seg = segmented([
      { value: 'editor', label: tr('Editor'), title: tr('Edit as Text') },
      { value: 'table', label: tr('Table'), title: tr('View as Table') },
    ], mode, (v) => setMode(v, true));
    const colSel = el('select', 'vw-select vw-filter-col');
    colSel.title = tr('Column to filter');
    const filterIn = el('input', 'vw-input vw-filter');
    filterIn.placeholder = tr('Filter rows…');
    const count = el('span', 'vw-count');
    const errorsLabel = el('span', 'vw-errors');
    const status = el('span', 'vw-status');
    const tableOnly = [colSel, filterIn, count, errorsLabel];
    if (doc) bar.append(seg.el);
    bar.append(colSel, filterIn, status, spacer(), errorsLabel, count);
    const area = el('div', 'vw-tv-area');
    const edHost = el('div', 'vw-tv-editor hidden');
    let editor = null;
    const grid = createGrid((line) => {
      if (!doc) return;
      setMode('editor', false);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.revealLineInCenter(line);
      editor.focus();
    });
    area.append(edHost, grid.el);
    host.append(bar, area);
    if (!doc) status.textContent = tr('Read-only: the file is too large for the editor.');

    let stale = true;
    let disposed = false;
    function refreshColumns() {
      const prev = colSel.value;
      colSel.replaceChildren(new Option(tr('All Columns'), '-1'));
      grid.columns.forEach((c, i) => colSel.add(new Option(c || String(i + 1), String(i))));
      colSel.value = [...colSel.options].some((o) => o.value === prev) ? prev : '-1';
    }
    grid.onChange = () => {
      count.textContent = grid.shown === grid.total
        ? tr('Rows: {n}', { n: grid.total.toLocaleString('en-US') })
        : tr('Rows: {shown} of {n}', { shown: grid.shown.toLocaleString('en-US'), n: grid.total.toLocaleString('en-US') });
      host.dataset.rows = String(grid.total);
      host.dataset.shown = String(grid.shown);
    };
    async function rebuild() {
      let text;
      if (doc) text = doc.model.getValue();
      else {
        // Parsed rows take many times the file's size, so a big file shows its first MAX_TABLE_BYTES, cut at a line end.
        status.textContent = tr('Loading…');
        const st = await invoke('viewers:stat', path).catch(() => null);
        const bytes = await invoke('viewers:readBytes', path, 0, MAX_TABLE_BYTES).catch(() => null);
        if (disposed) return;
        let end = bytes?.length || 0;
        const cut = !!st && st.size > end;
        if (cut) end = bytes.lastIndexOf(10) + 1 || end;
        text = bytes ? new TextDecoder().decode(bytes.subarray(0, end)) : '';
        status.textContent = cut
          ? tr('Read-only: the file is too large for the editor. The table shows its first {size} of {total}.', { size: fmtBytes(end), total: fmtBytes(st.size) })
          : tr('Read-only: the file is too large for the editor.');
      }
      const t0 = performance.now();
      const d = build(text);
      grid.set(d);
      refreshColumns();
      errorsLabel.textContent = d.errors ? tr('Parse errors: {n}', { n: d.errors }) : '';
      errorsLabel.classList.toggle('hidden', !d.errors);
      host.dataset.errors = String(d.errors || 0);
      host.dataset.parseMs = String(Math.round(performance.now() - t0));
      host.dataset.loaded = 'true';
      stale = false;
    }
    const scheduled = debounce(() => { if (mode === 'table') rebuild(); }, 300);
    const sub = doc?.model.onDidChangeContent(() => { stale = true; scheduled(); });
    const applyFilter = () => grid.setFilter(Number(colSel.value), filterIn.value);
    filterIn.oninput = debounce(applyFilter, 120);
    colSel.onchange = applyFilter;

    function setMode(v, persist) {
      mode = v;
      seg.set(v);
      host.dataset.mode = v;
      edHost.classList.toggle('hidden', v !== 'editor');
      grid.el.classList.toggle('hidden', v !== 'table');
      for (const n of tableOnly) n.classList.toggle('hidden', v !== 'table' || (n === errorsLabel && !Number(host.dataset.errors)));
      if (v === 'editor' && !editor) editor = embedEditor(edHost, doc);
      if (v === 'editor') editor.layout();
      if (v === 'table' && stale) rebuild();
      if (persist) ide.settings.set(settingKey, v);
    }
    host.addEventListener('focus', () => { if (mode === 'editor') editor?.focus(); else grid.el.focus(); });
    setMode(mode);
    host._viewer = { setMode, grid, get editor() { return editor; } };
    return {
      dispose: () => {
        disposed = true;
        scheduled.cancel();
        sub?.dispose();
        grid.dispose();
        editor?.dispose();
      },
    };
  }

  // ---------- registration ----------
  ide.registerFileViewer({ id: 'image', icon: '🖼', match: byExt(...IMAGE_EXT), mount: mountImage });
  ide.registerFileViewer({ id: 'video', icon: '🎬', match: byExt(...VIDEO_EXT), mount: mountVideo });
  ide.registerFileViewer({ id: 'audio', icon: '🎵', match: byExt(...AUDIO_EXT), mount: mountAudio });
  ide.registerFileViewer({ id: 'numpy', icon: '🔢', match: byExt('npy', 'npz'), mount: mountNumpy });
  // .bin is ambiguous (PyTorch weights, firmware, raw data); only binary .bin files get the model viewer.
  ide.registerFileViewer({ id: 'model', icon: '🧠', match: byExt(...MODEL_EXT.filter((e) => e !== 'bin')), mount: mountModel });
  ide.registerFileViewer({ id: 'model-bin', icon: '🧠', binaryOnly: true, match: (p) => ext(p) === 'bin' && /pytorch_model|model|weights/i.test(basename(p)), mount: mountModel });
  ide.registerFileViewer({ id: 'markdown', icon: '📝', text: true, match: byExt('md', 'markdown'), mount: mountMarkdown });
  // Django and Jinja2 templates stay in the editor with their template language: {% %} and {{ }} do not preview.
  const isPage = byExt('html', 'htm', 'xhtml');
  ide.registerFileViewer({ id: 'html', icon: '🌐', text: true, match: (p) => isPage(p) && !ide.frameworks?.templateLanguage?.(p), mount: mountHtml });
  ide.registerFileViewer({ id: 'csv', icon: '▦', text: true, match: byExt('csv', 'tsv'),
    mount: (host, ctx) => mountTableViewer(host, ctx, { kind: 'csv', build: (text) => tableFromCsv(text, ctx.path) }) });
  ide.registerFileViewer({ id: 'jsonl', icon: '▤', text: true, match: byExt('jsonl', 'ndjson'),
    mount: (host, ctx) => mountTableViewer(host, ctx, { kind: 'jsonl', build: tableFromJsonl }) });

  // For tests and other plugins.
  ide.viewers = { fileUrl, parseDelimited, tableFromJsonl, sniffAudio };
})();
