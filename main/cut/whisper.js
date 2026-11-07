// Speech recognition for Nano Studio Cut (docs/cut-architecture.md section 7): Whisper on the CPU, in a Python sidecar
// (main/ai/whisper_server.py) inside the one private AI environment that main/ai/runtime.js owns. Cut mode does not
// load the installer or the ai-* plugins, so setting the environment up and downloading a model happen here, and only
// when the person presses Download (cut:speechSetup).
//
// The renderer decodes and mixes the sound itself (16 kHz mono float32) and streams it in: cut:speechOpen gives a temp
// file, cut:speechWrite appends to it, cut:speechTranscribe recognises one window of it (at most 31 s; the renderer
// splits long sound and joins the windows), cut:speechClose deletes it. A file whose window closes goes with it, and
// files another (ended) process left behind are removed at start.
//
// PYIDE_WHISPER_BACKEND=fake (tests): no Python at all; one word per burst of sound (main/cut/speech-words.js).
// PYIDE_WHISPER_FAKE_SETUP=ok|offline|disk|noPython (tests, with the fake): the model and runtime start missing and
// cut:speechSetup pretends to download them, then succeeds or fails with that code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../ai/runtime');
const words = require('./speech-words');

const MODELS = [
  { id: 'whisper-small', repo: 'openai/whisper-small', name: 'Whisper small', bytes: 970e6 },
  { id: 'whisper-large-v3-turbo', repo: 'openai/whisper-large-v3-turbo', name: 'Whisper large-v3 turbo', bytes: 1625e6 },
];
// Only what transformers loads: the repos also hold PyTorch, TensorFlow and Flax copies of the weights.
const PATTERNS = ['*.json', '*.txt', 'model.safetensors'];
const NEEDED = ['model.safetensors', 'preprocessor_config.json', 'tokenizer.json'];
const RUNTIME_BYTES = 2.6e9; // torch (CPU) and transformers when nothing can be reused
const MARGIN = 300e6;
const RATE = words.RATE;
const MAX_WINDOW = 31 * RATE;
const WRITE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 2 * 1024 * 1024 * 1024; // about 9 hours
const LANGS = new Set(['auto', 'ko', 'en']);
// The person's word list (names, products, terms), given to Whisper as the text before each window. Whisper reads
// about 200 tokens of it; more than this is never useful.
const TERMS = { count: 200, chars: 100 };
const termsOf = (list) => (Array.isArray(list) ? list : []).filter((t) => typeof t === 'string')
  .map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= TERMS.chars).slice(0, TERMS.count);
const fail = (code, error) => ({ error, code });

// The kind of a failed setup, from its error and the end of its log: what the renderer explains in plain words.
function classify(text) {
  const t = String(text || '');
  if (/Cancelled/.test(t)) return 'cancelled';
  if (/No Python interpreter found/.test(t)) return 'noPython';
  if (/PyTorch has no build/.test(t)) return 'noTorch';
  if (/in use by another Nano Studio window/.test(t)) return 'busy';
  if (/No space left|Errno 28|not enough space|ENOSPC|disk is full/i.test(t)) return 'disk';
  if (/getaddrinfo|Failed to establish a new connection|Max retries exceeded|NameResolution|Temporary failure in name resolution|ConnectionError|ConnectTimeout|ReadTimeout|No matching distribution found|LocalEntryNotFound|OfflineModeIsEnabled|couldn't connect|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(t)) return 'offline';
  return 'failed';
}

// Free bytes on the drive of `dir` (or of the nearest folder above it that exists).
function freeBytes(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch {}
    const up = path.dirname(d);
    if (up === d) return Infinity;
    d = up;
  }
}
function dirBytes(dir) {
  let n = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else { try { n += fs.statSync(p).size; } catch {} }
  }
  return n;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

function createSpeech({ script, tmpDir = path.join(os.tmpdir(), 'nano-studio-speech'), log, env = process.env } = {}) {
  const fake = env.PYIDE_WHISPER_BACKEND === 'fake';
  const fakeSetup = fake ? env.PYIDE_WHISPER_FAKE_SETUP || '' : '';
  const fakeState = { runtime: !fakeSetup, models: new Set(fakeSetup ? [] : MODELS.map((m) => m.id)), delay: 0, load: 0, stopAfter: 0 };
  const stats = { setups: 0, windows: 0, cancelled: 0 };
  const modelOf = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
  const installed = (m) => (fake ? fakeState.models.has(m.id) : NEEDED.every((f) => !!runtime.hfCachedFile(m.repo, f)));
  const runtimeReady = () => {
    if (fake) return fakeState.runtime;
    const torch = runtime.torchOnDisk();
    return runtime.pythonReady() && !!torch && runtime.usable(torch) && ['transformers', 'numpy', 'huggingface_hub'].every(runtime.importable);
  };
  let engine = { state: 'idle', model: null }; // idle | loading | ready
  let lastSender = null;
  const tell = (wc, channel, payload) => { try { if (wc && !wc.isDestroyed?.()) wc.send(channel, payload); } catch {} };
  const setEngine = (e) => { engine = { ...engine, ...e }; tell(lastSender, 'cut:speechState', engine); };
  const status = () => ({
    backend: fake ? 'fake' : 'whisper',
    runtime: runtimeReady(),
    runtimeBytes: RUNTIME_BYTES,
    models: MODELS.map((m) => ({ id: m.id, name: m.name, repo: m.repo, bytes: m.bytes, installed: installed(m) })),
    engine,
    stats,
  });

  // ---------- temp files of sound ----------
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      const pid = Number(/^(\d+)-/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) fs.rm(path.join(tmpDir, name), { force: true }, () => {});
    }
  } catch {}
  const files = new Map(); // id -> {owner, file, size, fh, queue}
  let nextFile = 1;
  async function open(owner) {
    const id = `s${nextFile++}`;
    const file = path.join(tmpDir, `${process.pid}-${id}.f32`);
    try {
      const fh = await fs.promises.open(file, 'w+');
      files.set(id, { owner, file, size: 0, fh, queue: Promise.resolve() });
      return { id };
    } catch (err) { return fail('io', err.message); }
  }
  const own = (owner, id) => { const f = files.get(id); return f && f.owner === owner ? f : null; };
  function write(owner, id, bytes) {
    const f = own(owner, id);
    if (!f) return fail('notFound', 'no such sound file');
    if (!(bytes instanceof Uint8Array) || bytes.length % 4) return fail('badArgs', 'write takes float32 samples');
    if (bytes.length > WRITE_LIMIT) return fail('tooLarge', 'one write is 16 MB at most');
    if (f.size + bytes.length > FILE_LIMIT) return fail('tooLarge', 'the sound is too long');
    const at = f.size;
    f.size += bytes.length;
    const done = f.queue.then(() => f.fh.write(bytes, 0, bytes.length, at)).then(() => ({ ok: true, samples: f.size / 4 }), (err) => fail('io', err.message));
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
  async function readSamples(f, offset, length) {
    await f.queue.catch(() => {});
    const n = Math.max(0, Math.min(length, f.size / 4 - offset));
    const buf = Buffer.alloc(n * 4);
    if (n) await f.fh.read(buf, 0, n * 4, offset * 4);
    return new Float32Array(buf.buffer, buf.byteOffset, n);
  }

  // ---------- recognising ----------
  let sidecar = null;
  let idleMs = runtime.idleMsOf();
  function startServer() {
    if (sidecar?.alive()) return sidecar;
    const sc = runtime.startSidecar({
      script,
      // The model was downloaded when the person asked; loading it never goes to the network.
      env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TRANSFORMERS_VERBOSITY: 'error' },
      idleMs: () => idleMs,
      onEvent: (msg) => {
        if (msg.event === 'loading') setEngine({ state: 'loading' });
        else if (msg.event === 'ready') setEngine({ state: 'ready', loadMs: msg.ms });
      },
      onLog: (text) => log?.info?.(`whisper: ${text.trim().slice(0, 400)}`),
      onExit: () => { if (sidecar === sc) { sidecar = null; setEngine({ state: 'idle', model: null }); } },
    });
    sidecar = sc;
    return sc;
  }
  const inflight = new Map(); // `${owner}:${request}` -> cancel()
  async function transcribe(owner, id, opts = {}, sender) {
    const f = own(owner, id);
    if (!f) return fail('notFound', 'no such sound file');
    const offset = Number(opts.offset);
    const length = Number(opts.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) return fail('badArgs', 'transcribe takes an offset and a length in samples');
    if (length > MAX_WINDOW) return fail('tooLarge', 'one window is 31 s at most');
    const language = LANGS.has(opts.language) ? opts.language : 'auto';
    const terms = termsOf(opts.terms);
    const m = modelOf(opts.model);
    const key = `${owner}:${opts.request}`;
    if (sender) lastSender = sender;
    if (!runtimeReady() || !installed(m)) return fail('notInstalled', `${m.name} is not installed`);
    stats.windows++;
    const samples = await readSamples(f, offset, length);
    if (fake) {
      // like the sidecar: the model loads on the first request for it (fakeState.load ms)
      if (engine.model !== m.id || engine.state !== 'ready') {
        setEngine({ state: 'loading', model: m.id });
        await new Promise((r) => setTimeout(r, fakeState.load));
        setEngine({ state: 'ready', loadMs: fakeState.load });
      }
      let cancel;
      const stopped = new Promise((resolve) => { cancel = () => resolve(true); });
      inflight.set(key, cancel);
      const late = await Promise.race([stopped, new Promise((r) => setTimeout(() => r(false), fakeState.delay))]);
      inflight.delete(key);
      if (late) { stats.cancelled++; return { cancelled: true }; }
      let heard = words.fakeWords(samples, { offset, total: f.size / 4, language: language === 'en' ? 'en' : 'ko', terms });
      let end = null;
      // like Whisper under music: the file's first window ends after stopAfter seconds of text
      if (fakeState.stopAfter > 0 && offset === 0) {
        heard = heard.filter(([a]) => a < fakeState.stopAfter);
        end = heard.length ? heard[heard.length - 1][1] : null;
      }
      return { words: heard, end, language: language === 'en' ? 'en' : 'ko' };
    }
    const sc = startServer();
    if (engine.model !== m.id) setEngine({ model: m.id });
    const job = sc.send({ op: 'transcribe', model: m.repo, file: f.file, offset, length, language, terms });
    inflight.set(key, () => sc.notify({ op: 'cancel', target: job.id }));
    // The file is complete up to here: the writes before this request were awaited in readSamples.
    const r = await job.reply;
    inflight.delete(key);
    if (r.cancelled) { stats.cancelled++; return { cancelled: true }; }
    if (r.error) return fail('model', r.error);
    return { words: words.refine(samples, r.words || []), end: r.end ?? null, language: r.language || null, ms: r.ms };
  }
  const cancel = (owner, request) => { inflight.get(`${owner}:${request}`)?.(); return true; };

  // ---------- setup: the shared runtime, then the model ----------
  let setupJob = null;
  async function setup(modelId, sender) {
    const m = modelOf(modelId);
    stats.setups++;
    const progress = (p) => tell(sender, 'cut:speechProgress', { model: m.id, ...p });
    if (fake) return fakeSetupRun(m, progress);
    if (setupJob) return fail('busy', 'a download is already running');
    let tail = '';
    let setupPhase = 'runtime';
    const job = runtime.createJob((text) => {
      tail = (tail + text).slice(-6000);
      const line = text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) progress({ phase: setupPhase, text: line.slice(0, 200) });
    });
    setupJob = job;
    let timer = null;
    try {
      const need = (installed(m) ? 0 : m.bytes) + (runtimeReady() ? 0 : RUNTIME_BYTES) + MARGIN;
      const free = Math.min(freeBytes(runtime.hfCacheDir()), runtimeReady() ? Infinity : freeBytes(runtime.dir));
      if (free < need) return { ok: false, code: 'disk', error: `${Math.ceil(need / 1e9 * 10) / 10} GB needed, ${Math.floor(free / 1e9 * 10) / 10} GB free`, need, free };
      if (!runtimeReady()) {
        progress({ phase: 'runtime', fraction: null });
        await runtime.exclusive(async () => {
          await runtime.ensureVenv(job, null, { torch: true });
          if (!(await runtime.torchUsable())) await runtime.pipInstall(job, [runtime.TORCH]);
          const missing = ['transformers', 'numpy', 'huggingface_hub'].filter((p) => !runtime.importable(p));
          if (missing.length) await runtime.pipInstall(job, missing.map((p) => p.replace('_', '-')));
        });
      }
      if (!installed(m)) {
        setupPhase = 'download';
        const blobs = path.join(runtime.hfRepoDir(m.repo), 'blobs');
        const tick = () => progress({ phase: 'download', fraction: Math.min(0.99, dirBytes(blobs) / m.bytes), bytes: m.bytes });
        tick();
        timer = setInterval(tick, 500);
        const code = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, allow_patterns=${JSON.stringify(PATTERNS)})`;
        await job.run(runtime.python, ['-c', code]);
        clearInterval(timer);
        timer = null;
        if (!installed(m)) throw new Error(`${m.name} was not downloaded completely`);
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
  // The pretend download of the tests: a runtime step, then ten steps of the model.
  let fakeCancel = null;
  async function fakeSetupRun(m, progress) {
    let stop = false;
    fakeCancel = () => { stop = true; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (!fakeState.runtime) { progress({ phase: 'runtime', fraction: null, text: 'Collecting transformers' }); await wait(300); }
      for (let i = 1; i <= 10; i++) {
        if (stop) return { ok: false, code: 'cancelled', error: 'Cancelled' };
        if (fakeSetup !== 'ok' && i === 4) return { ok: false, code: fakeSetup, error: `pretend failure: ${fakeSetup}` };
        progress({ phase: 'download', fraction: i / 10, bytes: m.bytes });
        await wait(120);
      }
      fakeState.runtime = true;
      fakeState.models.add(m.id);
      progress({ phase: 'done', fraction: 1 });
      return { ok: true };
    } finally { fakeCancel = null; }
  }
  const cancelSetup = () => { setupJob?.cancel(); fakeCancel?.(); return true; };

  async function ownerGone(owner) {
    for (const [id, f] of files) if (f.owner === owner) await close(owner, id);
  }
  async function dispose() {
    for (const [id, f] of files) await close(f.owner, id);
    if (sidecar?.alive()) await sidecar.kill();
  }

  return {
    MODELS, status, open, write, close, transcribe, cancel, setup, cancelSetup, ownerGone, dispose, classify,
    // A sound file of open(), for main/cut/speakers.js, once its writes are done: {file, samples, read(offset, length)}.
    async sound(owner, id) {
      const f = own(owner, id);
      if (!f) return null;
      await f.queue.catch(() => {});
      return { file: f.file, samples: f.size / 4, read: (offset, length) => readSamples(f, offset, length) };
    },
    configure({ idleMinutes } = {}) { idleMs = runtime.idleMsOf(idleMinutes); sidecar?.idle(); return true; },
    // fake only: delay (ms per window), load (ms the next model load takes), unload (the model goes, as after idle),
    // stopAfter (s: the first window's text stops there, 0 = off), installed (the ids of the models on this PC)
    testConfig(cfg = {}) {
      if (!fake) return false;
      if (Array.isArray(cfg.installed)) fakeState.models = new Set(MODELS.map((m) => m.id).filter((id) => cfg.installed.includes(id)));
      if (Number.isFinite(cfg.delay)) fakeState.delay = Math.max(0, cfg.delay);
      if (Number.isFinite(cfg.load)) fakeState.load = Math.max(0, cfg.load);
      if (Number.isFinite(cfg.stopAfter)) fakeState.stopAfter = Math.max(0, cfg.stopAfter);
      if (cfg.unload) setEngine({ state: 'idle', model: null });
      return true;
    },
    get sidecarAlive() { return !!sidecar?.alive(); },
  };
}

module.exports = { createSpeech, classify, termsOf, MODELS, TERMS };
