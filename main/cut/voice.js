// Voice isolation for Nano Studio Cut (docs/cut-architecture.md section 7): the vocals stem of HTDemucs on the CPU, in
// a Python sidecar (main/ai/voice_server.py) inside the private AI environment of main/ai/runtime.js, the one speech
// recognition uses. Like main/cut/whisper.js, the environment and the model are set up here, and only when the person
// presses Download (cut:voiceSetup).
//
// The renderer decodes the sound itself (44.1 kHz float32, one or two channels interleaved) and streams it in:
// cut:voiceOpen gives a temp file, cut:voiceWrite appends, cut:voiceSeparate writes the vocals to a 16-bit WAV that main
// names and places (never next to the person's media), cut:voiceClose deletes the temp file. A WAV is written as .part
// and renamed when complete, so a cancelled or failed separation leaves nothing.
//   place 'media': <Cut workspace>\Media, for files the project imports (Isolate Voice); outside the cache's LRU.
//   place 'cache': <Cut workspace>\Cache, for the sound speech recognition reads (made again when needed).
//
// PYIDE_VOICE_BACKEND=fake (tests): no Python; the vocals are the sound itself, at `delay` ms per second of it.
// PYIDE_VOICE_FAKE_SETUP=ok|offline|disk|noPython (tests, with the fake): the model and runtime start missing and
// cut:voiceSetup pretends to download them, then succeeds or fails with that code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../ai/runtime');
const { classify } = require('./whisper');
const { renameOver } = require('./project');

const MODEL = { id: 'htdemucs', repo: 'adefossez/HTDemucs', name: 'HTDemucs', bytes: 84e6 };
const RATE = 44100;
// What the sidecar imports (folders, or a module file, in the environment's site-packages). demucs' own audio and
// pretrained helpers want torchaudio; the sidecar builds the model itself, so torchaudio is never needed.
const PACKAGES = ['demucs', 'einops', 'julius', 'safetensors', 'soundfile.py', 'tqdm', 'numpy'];
// demucs is installed without its dependencies (they would pull in torchaudio, dora and openunmix); these are the ones
// the separation imports, and huggingface_hub downloads the model.
const PIP_DEPS = ['einops', 'julius', 'safetensors', 'soundfile', 'tqdm', 'numpy', 'huggingface_hub'];
const RUNTIME_BYTES = 2.6e9; // torch (CPU) when nothing can be reused
const PACKAGES_BYTES = 60e6;
const MARGIN = 300e6;
const WRITE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 4 * 1024 * 1024 * 1024; // about 3.4 hours of stereo
const fail = (code, error) => ({ error, code });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// A WAV's name from the media's: the characters Windows refuses dropped, at most 60 of the rest.
const cleanName = (name) => String(name || 'sound').replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 60) || 'sound';
const fileName = (name, key) => `${cleanName(name)} voice ${key}.wav`;

function freeBytes(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch {}
    const up = path.dirname(d);
    if (up === d) return Infinity;
    d = up;
  }
}

// A 16-bit PCM WAV header for `frames` frames (the fake backend's output).
function wavHeader(frames, channels) {
  const data = frames * channels * 2;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40);
  return b;
}

function createVoice({ script, mediaDir, cacheDir, tmpDir = path.join(os.tmpdir(), 'nano-studio-voice'), onCached, log, env = process.env } = {}) {
  const fake = env.PYIDE_VOICE_BACKEND === 'fake';
  const fakeSetup = fake ? env.PYIDE_VOICE_FAKE_SETUP || '' : '';
  const fakeState = { runtime: !fakeSetup, model: !fakeSetup, delay: 0 };
  const stats = { setups: 0, separations: 0, cancelled: 0, last: null };
  // The model's weight files: htdemucs.yaml names them (`models: ['955717e8']`, one or a bag of several).
  const weights = () => {
    const yaml = runtime.hfCachedFile(MODEL.repo, 'htdemucs.yaml');
    if (!yaml) return null;
    let names = [];
    try { names = (/models:\s*\[([^\]]*)\]/.exec(fs.readFileSync(yaml, 'utf8'))?.[1] || '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean); } catch {}
    const files = names.map((n) => path.join(path.dirname(yaml), `${n}.safetensors`));
    return files.length && files.every((f) => fs.existsSync(f)) ? files : null;
  };
  const installed = () => (fake ? fakeState.model : !!weights());
  const torchReady = () => { const v = runtime.torchOnDisk(); return !!v && runtime.usable(v); };
  const runtimeReady = () => (fake ? fakeState.runtime : runtime.pythonReady() && torchReady() && PACKAGES.every(runtime.importable));
  let engine = { state: 'idle' };
  let lastSender = null;
  const tell = (wc, channel, payload) => { try { if (wc && !wc.isDestroyed?.()) wc.send(channel, payload); } catch {} };
  const setEngine = (e) => { engine = { ...engine, ...e }; tell(lastSender, 'cut:voiceState', engine); };
  const status = () => ({
    backend: fake ? 'fake' : 'demucs',
    runtime: runtimeReady(),
    runtimeBytes: fake || torchReady() ? PACKAGES_BYTES : RUNTIME_BYTES,
    model: { ...MODEL, installed: installed() },
    engine,
    stats,
    open: files.size,
  });
  const dirOf = (place) => (place === 'cache' ? cacheDir : mediaDir);
  const checkKey = (o) => (typeof o?.key === 'string' && /^[0-9a-f]{8,32}$/.test(o.key) ? null : fail('badArgs', 'a key is 8 to 32 hex digits'));

  // A WAV made before for this key, in the media folder first (Isolate Voice), then the cache.
  function find(o = {}) {
    if (checkKey(o)) return checkKey(o);
    for (const place of ['media', 'cache']) {
      const p = path.join(dirOf(place), fileName(o.name, o.key));
      try { if (fs.statSync(p).size > 44) return { path: p, place }; } catch {}
    }
    return { missing: true };
  }

  // ---------- temp files of sound ----------
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      const pid = Number(/^(\d+)-/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) fs.rm(path.join(tmpDir, name), { force: true }, () => {});
    }
  } catch {}
  const files = new Map(); // id -> {owner, file, size, fh, queue, channels}
  let nextFile = 1;
  async function open(owner, o = {}) {
    const channels = o?.channels === 1 ? 1 : 2;
    const id = `v${nextFile++}`;
    const file = path.join(tmpDir, `${process.pid}-${id}.f32`);
    try {
      const fh = await fs.promises.open(file, 'w+');
      files.set(id, { owner, file, size: 0, fh, queue: Promise.resolve(), channels });
      return { id };
    } catch (err) { return fail('io', err.message); }
  }
  const own = (owner, id) => { const f = files.get(id); return f && f.owner === owner ? f : null; };
  function write(owner, id, bytes) {
    const f = own(owner, id);
    if (!f) return fail('notFound', 'no such sound file');
    if (!(bytes instanceof Uint8Array) || bytes.length % (4 * f.channels)) return fail('badArgs', 'write takes whole float32 frames');
    if (bytes.length > WRITE_LIMIT) return fail('tooLarge', 'one write is 16 MB at most');
    if (f.size + bytes.length > FILE_LIMIT) return fail('tooLarge', 'the sound is too long');
    const at = f.size;
    f.size += bytes.length;
    const done = f.queue.then(() => f.fh.write(bytes, 0, bytes.length, at)).then(() => ({ ok: true, frames: f.size / 4 / f.channels }), (err) => fail('io', err.message));
    f.queue = done;
    return done;
  }
  async function close(owner, id) {
    const f = own(owner, id);
    if (!f) return { ok: true };
    files.delete(id);
    await f.queue.catch(() => {});
    await f.fh.close().catch(() => {});
    await fs.promises.rm(f.file, { force: true }).catch(() => {});
    return { ok: true };
  }

  // ---------- separating ----------
  let sidecar = null;
  let idleMs = runtime.idleMsOf();
  const jobs = new Map(); // the sidecar's request id -> {sender, request}
  function startServer() {
    if (sidecar?.alive()) return sidecar;
    const sc = runtime.startSidecar({
      script,
      env: { HF_HUB_OFFLINE: '1' },
      idleMs: () => idleMs,
      onEvent: (msg) => {
        if (msg.event === 'loading') setEngine({ state: 'loading' });
        else if (msg.event === 'ready') setEngine({ state: 'ready', loadMs: msg.ms });
        else if (msg.event === 'progress') {
          const j = jobs.get(msg.request);
          if (j) tell(j.sender, 'cut:voiceProgress', { request: j.request, fraction: msg.fraction });
        }
      },
      onLog: (text) => log?.info?.(`voice: ${text.trim().slice(0, 400)}`),
      onExit: () => { if (sidecar === sc) { sidecar = null; setEngine({ state: 'idle' }); } },
    });
    sidecar = sc;
    return sc;
  }
  const inflight = new Map(); // `${owner}:${request}` -> cancel()
  async function separate(owner, id, o = {}, sender) {
    const f = own(owner, id);
    if (!f) return fail('notFound', 'no such sound file');
    if (checkKey(o)) return checkKey(o);
    const place = o.place === 'cache' ? 'cache' : 'media';
    const frames = Number.isSafeInteger(o.frames) && o.frames >= 0 ? o.frames : 0;
    if (sender) lastSender = sender;
    if (!runtimeReady() || !installed()) return fail('notInstalled', 'HTDemucs is not installed');
    const dir = dirOf(place);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (err) { return fail('io', err.message); }
    await f.queue.catch(() => {});
    const total = Math.max(f.size / 4 / f.channels, frames);
    const need = total * f.channels * 2 + 1e6;
    if (freeBytes(dir) < need) return fail('disk', `${Math.ceil(need / 1e6)} MB needed in ${dir}`);
    const out = path.join(dir, fileName(o.name, o.key));
    const part = `${out}.part`;
    const key = `${owner}:${o.request}`;
    stats.separations++;
    stats.last = { place, channels: f.channels, frames: total };
    const started = Date.now();
    let r;
    if (fake) {
      let stop = false;
      inflight.set(key, () => { stop = true; });
      try {
        const fh = await fs.promises.open(part, 'w');
        try {
          await fh.write(wavHeader(total, f.channels), 0, 44, 0);
          const step = RATE * 10;
          const have = f.size / 4 / f.channels;
          for (let at = 0; at < total && !stop; at += step) {
            const n = Math.min(step, total - at);
            const pcm = Buffer.alloc(n * f.channels * 2);
            const m = Math.max(0, Math.min(n, have - at));
            if (m) {
              const raw = Buffer.alloc(m * f.channels * 4);
              await f.fh.read(raw, 0, raw.length, at * f.channels * 4);
              for (let i = 0; i < m * f.channels; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, raw.readFloatLE(4 * i))) * 32767), 2 * i);
            }
            await fh.write(pcm, 0, pcm.length, 44 + at * f.channels * 2);
            tell(sender, 'cut:voiceProgress', { request: o.request, fraction: Math.min(1, (at + n) / total) });
            if (fakeState.delay) await new Promise((res) => setTimeout(res, (fakeState.delay * n) / RATE));
          }
        } finally { await fh.close(); }
        r = stop ? { cancelled: true } : { ok: true, frames: total };
      } catch (err) { r = { error: err.message }; } finally { inflight.delete(key); }
    } else {
      const sc = startServer();
      const job = sc.send({ op: 'separate', weights: weights(), file: f.file, channels: f.channels, frames, out: part });
      jobs.set(job.id, { sender, request: o.request });
      inflight.set(key, () => sc.notify({ op: 'cancel', target: job.id }));
      r = await job.reply;
      inflight.delete(key);
      jobs.delete(job.id);
    }
    if (!r.ok) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      if (r.cancelled) { stats.cancelled++; return { cancelled: true }; }
      return fail('model', r.error || 'the separation failed');
    }
    try { await renameOver(part, out); } catch (err) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      return fail('io', err.message);
    }
    if (place === 'cache') await onCached?.(out);
    return { ok: true, path: out, place, frames: r.frames, ms: Date.now() - started };
  }
  const cancel = (owner, request) => { inflight.get(`${owner}:${request}`)?.(); return true; };

  // ---------- setup: the shared runtime and the packages, then the model ----------
  let setupJob = null;
  async function setup(sender) {
    stats.setups++;
    const progress = (p) => tell(sender, 'cut:voiceSetupProgress', p);
    if (fake) return fakeSetupRun(progress);
    if (setupJob) return fail('busy', 'a download is already running');
    let tail = '';
    let phase = 'runtime';
    const job = runtime.createJob((text) => {
      tail = (tail + text).slice(-6000);
      const line = text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) progress({ phase, text: line.slice(0, 200) });
    });
    setupJob = job;
    let timer = null;
    try {
      const need = (installed() ? 0 : MODEL.bytes) + (runtimeReady() ? 0 : status().runtimeBytes) + MARGIN;
      const free = Math.min(freeBytes(runtime.hfCacheDir()), runtimeReady() ? Infinity : freeBytes(runtime.dir));
      if (free < need) return { ok: false, code: 'disk', error: `${Math.ceil(need / 1e9 * 10) / 10} GB needed, ${Math.floor(free / 1e9 * 10) / 10} GB free`, need, free };
      if (!runtimeReady()) {
        progress({ phase: 'runtime', fraction: null });
        await runtime.exclusive(async () => {
          await runtime.ensureVenv(job, null, { torch: true });
          if (!(await runtime.torchUsable())) await runtime.pipInstall(job, [runtime.TORCH]);
          if (!runtime.importable('demucs')) await runtime.pipInstall(job, ['--no-deps', 'demucs']);
          await runtime.pipInstall(job, PIP_DEPS);
        });
      }
      if (!installed()) {
        phase = 'download';
        const blobs = path.join(runtime.hfRepoDir(MODEL.repo), 'blobs');
        const tick = () => {
          let n = 0;
          try { for (const b of fs.readdirSync(blobs)) { try { n += fs.statSync(path.join(blobs, b)).size; } catch {} } } catch {}
          progress({ phase: 'download', fraction: Math.min(0.99, n / MODEL.bytes), bytes: MODEL.bytes });
        };
        tick();
        timer = setInterval(tick, 500);
        await runtime.hfDownload(job, MODEL.repo);
        clearInterval(timer);
        timer = null;
        if (!installed()) throw new Error(`${MODEL.name} was not downloaded completely`);
      }
      progress({ phase: 'done', fraction: 1 });
      return { ok: true };
    } catch (err) {
      const message = String(err?.message || err);
      return { ok: false, code: classify(`${message}\n${tail}`), error: message, log: tail.slice(-2000) };
    } finally {
      clearInterval(timer);
      if (setupJob === job) setupJob = null;
    }
  }
  let fakeCancel = null;
  async function fakeSetupRun(progress) {
    let stop = false;
    fakeCancel = () => { stop = true; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (!fakeState.runtime) { progress({ phase: 'runtime', fraction: null, text: 'Collecting demucs' }); await wait(300); }
      for (let i = 1; i <= 10; i++) {
        if (stop) return { ok: false, code: 'cancelled', error: 'Cancelled' };
        if (fakeSetup !== 'ok' && i === 4) return { ok: false, code: fakeSetup, error: `pretend failure: ${fakeSetup}` };
        progress({ phase: 'download', fraction: i / 10, bytes: MODEL.bytes });
        await wait(100);
      }
      fakeState.runtime = true;
      fakeState.model = true;
      progress({ phase: 'done', fraction: 1 });
      return { ok: true };
    } finally { fakeCancel = null; }
  }
  const cancelSetup = () => { setupJob?.cancel(); fakeCancel?.(); return true; };

  async function ownerGone(owner) {
    for (const [k, stop] of inflight) if (k.startsWith(`${owner}:`)) stop();
    for (const [id, f] of files) if (f.owner === owner) await close(owner, id);
  }
  async function dispose() {
    for (const stop of inflight.values()) stop();
    for (const [id, f] of files) await close(f.owner, id);
    if (sidecar?.alive()) await sidecar.kill();
  }

  return {
    MODEL, status, find, open, write, close, separate, cancel, setup, cancelSetup, ownerGone, dispose,
    configure({ idleMinutes } = {}) { idleMs = runtime.idleMsOf(idleMinutes); sidecar?.idle(); return true; },
    // fake only: delay (ms per second of sound)
    testConfig(cfg = {}) {
      if (!fake) return false;
      if (Number.isFinite(cfg.delay)) fakeState.delay = Math.max(0, cfg.delay);
      return true;
    },
    get sidecarAlive() { return !!sidecar?.alive(); },
  };
}

module.exports = { createVoice, cleanName, fileName, MODEL, RATE };
