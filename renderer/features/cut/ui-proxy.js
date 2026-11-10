// Proxies (video-editor-features.md section 16 [1]): small H.264 copies of video media that the monitors play when
// their Proxy switch is on; export always reads the originals.
//
// "Create Proxy" (the project panel's menus, Find Action) queues the chosen video media. One job runs at a time in the
// background: a one-clip sequence of the media at the proxy size (the short side `cut.proxy.height`, 720 by default)
// and the nearest editor frame rate goes through Cut.export.run with no sound and a keyframe every 15 frames, into the
// Cut cache folder (proxy-<hash of path, size, mtime, height>.mp4, so the cache's size limit and Clear Cache cover
// it). It waits while a monitor plays (export's gate) and shows its progress in the status bar, where it can be
// cancelled. When it is done the media gets `proxy` (Cut.commands.setProxy through history.amend: no undo step) if the project is still
// the one it was made for; a proxy file that already exists for the media is used at once. A proxy whose file goes
// away plays the original (Cut.media.open).
//
// After an import, video media that are 4K or larger, HEVC, or have keyframes more than 2 seconds apart are offered
// proxies in a bar on the project panel (`cut.proxy.offer`); dismissing it is remembered for the project (setting
// `cut.proxy.dismissed`, the project's autosave key).
//
// Cut.ui.proxy: create(app, mediaIds), cancel(mediaId), remove(app, mediaIds), state(media) -> {state, fraction},
// jobs(), offer(app, mediaIds), offerBanner(app) -> element | null, needs(media) -> reasons.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;
  const log = ide.logger('#cut');

  const KEY_EVERY = 15;
  const LONG_GOP_SECONDS = 2;
  const DISMISSED = 'cut.proxy.dismissed';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const proxyHeight = () => { const h = Number(ide.settings.get('cut.proxy.height', 720)); return [540, 720, 1080].includes(h) ? h : 720; };

  // The proxy's size: the short side `height`, never larger than the media.
  function sizeOf(m, height = proxyHeight()) {
    const w = m.video?.w || 1920;
    const h = m.video?.h || 1080;
    const k = Math.min(1, height / Math.min(w, h));
    return [even(w * k), even(h * k)];
  }
  // FNV-1a of a text, twice with two seeds: 16 hex digits.
  function hash(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  let cacheDir = null;
  async function pathOf(m, height = proxyHeight()) {
    cacheDir ||= (await ide.api.invoke('cut:home'))?.cache;
    if (!cacheDir) throw new Error('The cache folder is not available.');
    return `${cacheDir}\\proxy-${hash(`${String(m.path).toLowerCase()}|${m.size}|${m.mtime}|${height}`)}-${height}p.mp4`;
  }
  const nearestRate = (fps) => {
    if (Cut.model.validFps(fps)) return [fps[0], fps[1]];
    const v = fps ? fps[0] / fps[1] : 30;
    return Cut.time.FRAME_RATES.reduce((best, r) => (Math.abs(r[0] / r[1] - v) < Math.abs(best[0] / best[1] - v) ? r : best), [30, 1]);
  };

  // ---------- the queue ----------
  const jobs = []; // {id, mediaId, name, history, media (a copy), state, fraction, paused, controller, task, path, error}
  let nextJob = 1;
  let running = null;
  const changed = () => { Cut.app?.emit('proxies', { jobs: jobs.length }); };
  const jobOf = (mediaId) => jobs.find((j) => j.mediaId === mediaId && (j.state === 'waiting' || j.state === 'running'));
  const playing = () => !!Cut.app?.playing || !!ui.monitors?.source?.player?.playing;

  function create(app, ids) {
    const list = (ids || []).map((id) => app.project?.media.find((m) => m.id === id)).filter(Boolean);
    const video = list.filter((m) => m.kind === 'video' && m.video && !ui.offline?.has(m.id));
    if (!video.length) { ui.toast(tr('Choose video media to make proxies of.')); return 0; }
    let n = 0;
    for (const m of video) {
      if (jobOf(m.id)) continue;
      jobs.push({ id: nextJob++, mediaId: m.id, name: m.name, history: app.history, media: JSON.parse(JSON.stringify(m)), state: 'waiting', fraction: 0, paused: false });
      n++;
    }
    if (n) ui.toast(tr('{n} proxies queued', { n }));
    changed();
    kick();
    return n;
  }
  function cancel(mediaId) {
    const j = jobOf(mediaId);
    if (!j) return false;
    if (j.state === 'running') j.controller?.abort();
    else { j.state = 'cancelled'; changed(); }
    return true;
  }
  // The media no longer plays its proxy (the file stays in the cache until the cache's limit or Clear Cache).
  function remove(app, ids) {
    const withProxy = ids.map((id) => app.project.media.find((m) => m.id === id)).filter((m) => m?.proxy);
    if (!withProxy.length) return;
    app.history.begin(tr('Remove Proxy'));
    try {
      for (const m of withProxy) app.history.do(Cut.commands.setProxy(m.id, null));
      app.history.commit();
    } catch (err) { app.history.cancel(); ui.report(err); }
    changed();
  }

  async function kick() {
    if (running) return;
    const job = jobs.find((j) => j.state === 'waiting');
    if (!job) return;
    running = job;
    try { await run(job); } catch (err) { job.state = 'failed'; job.error = err?.message || String(err); log.warn(`proxy of ${job.name}: ${job.error}`); }
    running = null;
    job.task?.done();
    changed();
    // Finished jobs leave the list; a failed one stays for its message until the next run.
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i] !== job && ['done', 'cancelled'].includes(jobs[i].state)) jobs.splice(i, 1);
    kick();
  }

  // Sets the media's proxy in the project the job was made for, outside any drag in progress.
  async function adopt(job, path) {
    const app = Cut.app;
    for (let i = 0; i < 600 && app.history === job.history && app.history.grouping; i++) await sleep(100);
    if (app.history !== job.history || !app.project.media.some((m) => m.id === job.mediaId)) return false;
    Cut.media?.forget?.(path);
    if (app.project.media.find((m) => m.id === job.mediaId).proxy?.path === path) return true;
    // Not an undo step: the job finishing would clear what the person can redo, or land between their steps.
    try { app.history.amend(Cut.commands.setProxy(job.mediaId, { path })); return true; } catch (err) { ui.report(err); return false; }
  }

  async function run(job) {
    const m = job.media;
    const height = proxyHeight();
    const path = await pathOf(m, height);
    job.path = path;
    job.state = 'running';
    changed();
    // A proxy made before (another project, an earlier session) is still in the cache.
    const st = await ide.api.invoke('cut:stat', path).catch(() => null);
    if (st && !st.missing && st.isFile && st.size > 0) {
      job.state = (await adopt(job, path)) ? 'done' : 'cancelled';
      return;
    }
    const [w, h] = sizeOf(m, height);
    const fps = nearestRate(m.video.fps);
    const project = Cut.model.createProject({ sequence: { name: 'proxy', w, h, fps, videoTracks: 1, audioTracks: 0 } });
    const hist = Cut.commands.createHistory(project);
    const seq = project.sequences[0];
    const { ids } = hist.do(Cut.commands.importMedia([{ ...m, id: undefined, proxy: null }]));
    hist.do(Cut.commands.place(seq.id, { source: { media: ids[0] }, in: 0, out: m.duration, at: 0, video: seq.tracks[0].id, audio: null, mode: 'overwrite' }));
    const settings = Cut.presets.resolve('720p', seq, { w, h, mode: 'variable' });
    settings.audio = null;
    settings.loudness = null;
    settings.video.keyInterval = KEY_EVERY;
    job.controller = new AbortController();
    job.task = ide.tasks?.start({ title: tr('Creating proxy for {name}', { name: m.name }), fraction: 0, onCancel: () => job.controller.abort() });
    const signal = job.controller.signal;
    const r = await Cut.export.run({
      project: hist.project, seqId: seq.id, path, settings, signal,
      gate: async () => {
        if (!playing()) return;
        job.paused = true;
        job.task?.update({ text: tr('Waiting while the player plays') });
        changed();
        while (playing() && !signal.aborted) await sleep(150);
        job.paused = false;
        job.task?.update({ text: '' });
        changed();
      },
      onProgress: (p) => {
        const f = p?.phase === 'video' ? p.fraction : p?.phase === 'finish' || p?.phase === 'verify' ? 1 : null;
        if (f == null) return;
        job.fraction = f;
        job.task?.update({ fraction: f });
        changed();
      },
    });
    if (signal.aborted || r?.code === 'cancelled') { job.state = 'cancelled'; return; }
    if (!r?.ok) {
      job.state = 'failed';
      job.error = r?.error || 'unknown error';
      ui.notify(tr('The proxy for {name} could not be made: {error}', { name: m.name, error: tr(String(job.error)) }), { kind: 'warn' });
      return;
    }
    job.fraction = 1;
    job.state = (await adopt(job, r.path || path)) ? 'done' : 'cancelled';
    if (job.state === 'done') ui.toast(tr('The proxy for {name} is ready', { name: m.name }));
  }

  // {state: 'none' | 'waiting' | 'running' | 'paused' | 'ready' | 'missing' | 'failed', fraction}
  function state(m) {
    const j = jobOf(m.id) || jobs.find((x) => x.mediaId === m.id && x.state === 'failed');
    if (j) return { state: j.state === 'running' && j.paused ? 'paused' : j.state, fraction: j.fraction, error: j.error };
    if (m.proxy?.path) return { state: Cut.media?.proxyMissing?.(m.proxy.path) ? 'missing' : 'ready', fraction: 1 };
    return { state: 'none', fraction: 0 };
  }

  // ---------- the offer on import ----------
  // Why a video would play better from a proxy: ['4k', 'hevc', 'gop'].
  async function needs(m) {
    const why = [];
    if (m.kind !== 'video' || !m.video) return why;
    if (m.video.w * m.video.h >= 3840 * 2160 * 0.9) why.push('4k');
    if (/^(hvc1|hev1)/.test(m.video.codec || '')) why.push('hevc');
    try {
      const o = await Cut.media.openPath(m.path, { size: m.size, mtime: m.mtime });
      const s = o?.video?.samples;
      if (s?.count) {
        let last = -1;
        let gap = 0;
        for (let i = 0; i < s.count; i++) {
          if (!s.key[i]) continue;
          if (last >= 0) gap = Math.max(gap, s.pts[i] - s.pts[last]);
          last = i;
        }
        if (last >= 0) gap = Math.max(gap, (s.pts[s.count - 1] + (s.duration?.[s.count - 1] || 0)) - s.pts[last]);
        if (gap > LONG_GOP_SECONDS * Cut.time.TICKS) why.push('gop');
      }
    } catch {}
    return why;
  }
  const dismissedList = () => { const v = ide.settings.get(DISMISSED, []); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
  const projectKey = () => String(ui.lifecycle?.key || '').toLowerCase();
  const isDismissed = () => !!projectKey() && dismissedList().includes(projectKey());
  function dismiss() {
    const k = projectKey();
    if (k && !isDismissed()) ide.settings.set(DISMISSED, [...dismissedList(), k].slice(-200));
    offered = null;
    changed();
  }
  let offered = null; // {history, ids, reasons}
  async function offer(app, ids) {
    watch();
    if (ide.settings.get('cut.proxy.offer', true) === false || isDismissed()) return null;
    const found = [];
    const reasons = new Set();
    for (const id of ids) {
      const m = app.project.media.find((x) => x.id === id);
      if (!m || m.proxy) continue;
      const why = await needs(m);
      if (!why.length) continue;
      found.push(id);
      for (const r of why) reasons.add(r);
    }
    if (!found.length) return null;
    const keep = offered?.history === app.history ? offered.ids : [];
    offered = { history: app.history, ids: [...new Set([...keep, ...found])], reasons: [...reasons] };
    changed();
    return offered;
  }
  const reasonText = (r) => ({ '4k': '4K', hevc: 'HEVC', gop: tr('keyframes far apart') })[r] || r;
  function offerBanner(app) {
    if (!offered || offered.history !== app.history) return null;
    const ids = offered.ids.filter((id) => app.project.media.some((m) => m.id === id && !m.proxy) && !jobOf(id));
    if (!ids.length) return null;
    const bar = el('div', 'cut-proxy-offer', undefined, { role: 'status' });
    bar.appendChild(el('span', 'cut-proxy-offer-text', tr('{n} imported clips may play slowly ({why}). Make proxies for smooth playback?', { n: ids.length, why: offered.reasons.map(reasonText).join(', ') })));
    bar.append(
      button({ label: tr('Create Proxies'), cls: 'cut-proxy-offer-create', onClick: () => { offered = null; create(app, ids); } }),
      button({ label: tr("Don't Ask for This Project"), cls: 'cut-proxy-offer-dismiss', onClick: () => dismiss() }),
    );
    return bar;
  }
  // A project saved for the first time keeps its untitled key's answer; another project drops the offer.
  let lastKey = null;
  let watched = null;
  function watch() {
    const app = Cut.app;
    if (!app || watched === app) return;
    watched = app;
    lastKey = projectKey();
    app.on('lifecycle', ({ reason }) => {
      const k = projectKey();
      if (reason === 'save' && lastKey && lastKey !== k && dismissedList().includes(lastKey) && !isDismissed()) ide.settings.set(DISMISSED, [...dismissedList(), k].slice(-200));
      if (reason !== 'save') { offered = null; changed(); }
      lastKey = k;
    });
  }

  ui.onAction('createProxy', ({ app }) => {
    const ids = ui.media?.selected?.() || [];
    if (!ids.length) return void ui.toast(tr('Select video media in the Project panel first.'));
    create(app, ids);
  });

  ui.proxy = {
    create, cancel, remove, state, needs, offer, offerBanner, dismiss, sizeOf, pathOf,
    jobs: () => jobs.map((j) => ({ id: j.id, mediaId: j.mediaId, name: j.name, state: j.state, paused: j.paused, fraction: j.fraction, path: j.path, error: j.error })),
    get running() { return running ? { mediaId: running.mediaId, paused: running.paused, fraction: running.fraction } : null; },
  };
})();
