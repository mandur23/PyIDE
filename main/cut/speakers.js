// Speaker labels for Nano Studio Cut (docs/cut-architecture.md, Cut.speakers): one speaker embedding per window of
// speech, from WeSpeaker ResNet34-LM (ONNX) in a Python sidecar (main/ai/speaker_server.py) inside the shared AI
// environment of main/ai/runtime.js. The renderer clusters the embeddings itself (renderer/features/cut/speakers.js).
//
// The sound is the one speech recognition streams in (main/cut/whisper.js: cut:speechOpen, cut:speechWrite): the
// renderer writes a media file's sound once, then cut:speakersEmbed reads windows of that temp file. The model and
// onnxruntime are downloaded only when the person presses Download (cut:speakersSetup); the sidecar never goes to the
// network.
//
// PYIDE_SPEAKERS_BACKEND=fake (tests): no Python; a window's embedding is its sound's energy at 24 frequencies, so
// test tones of different pitch are different speakers. PYIDE_SPEAKERS_FAKE_SETUP=ok|offline|disk|noPython (tests,
// with the fake): the model starts missing and cut:speakersSetup pretends to download it, then ends with that code.
const fs = require('fs');
const path = require('path');
const runtime = require('../ai/runtime');
const { classify } = require('./whisper');

const MODEL = {
  repo: 'Wespeaker/wespeaker-voxceleb-resnet34-LM', file: 'voxceleb_resnet34_LM.onnx', name: 'WeSpeaker ResNet34-LM', bytes: 26.5e6,
  files: ['voxceleb_resnet34_LM.onnx', 'config.yaml'],
};
const PACKAGES = ['onnxruntime', 'numpy', 'huggingface_hub'];
const RUNTIME_BYTES = 80e6; // onnxruntime and numpy when the environment has neither
const MARGIN = 100e6;
const RATE = 16000;
const MAX_WINDOW = 30 * RATE;
const MAX_WINDOWS = 20000;
const fail = (code, error) => ({ error, code });

// The fake backend's embedding: the energy at 24 log-spaced frequencies (Goertzel over 20 ms frames).
const FAKE_FREQS = Array.from({ length: 24 }, (_, k) => 150 * (4000 / 150) ** (k / 23));
function fakeEmbedding(x) {
  const out = new Float32Array(FAKE_FREQS.length);
  const frame = 320;
  FAKE_FREQS.forEach((f, k) => {
    const c = 2 * Math.cos((2 * Math.PI * f) / RATE);
    let e = 0;
    for (let a = 0; a + frame <= x.length; a += frame) {
      let s1 = 0;
      let s2 = 0;
      for (let i = a; i < a + frame; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      e += s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    out[k] = Math.sqrt(Math.max(0, e));
  });
  return out;
}

function createSpeakers({ script, speech, log, env = process.env } = {}) {
  const fake = env.PYIDE_SPEAKERS_BACKEND === 'fake';
  const fakeSetup = fake ? env.PYIDE_SPEAKERS_FAKE_SETUP || '' : '';
  const fakeState = { installed: !fakeSetup, delay: 0 };
  const stats = { setups: 0, embeds: 0, windows: 0, cancelled: 0 };
  const modelPath = () => runtime.hfCachedFile(MODEL.repo, MODEL.file);
  const installed = () => (fake ? fakeState.installed : MODEL.files.every((f) => !!runtime.hfCachedFile(MODEL.repo, f)));
  const runtimeReady = () => (fake ? fakeState.installed : runtime.pythonReady() && PACKAGES.every(runtime.importable));
  let engine = { state: 'idle' };
  const status = () => ({
    backend: fake ? 'fake' : 'wespeaker',
    runtime: runtimeReady(),
    runtimeBytes: RUNTIME_BYTES,
    model: { name: MODEL.name, repo: MODEL.repo, bytes: MODEL.bytes, installed: installed() },
    engine,
    stats,
  });

  let sidecar = null;
  let idleMs = runtime.idleMsOf();
  function startServer() {
    if (sidecar?.alive()) return sidecar;
    const sc = runtime.startSidecar({
      script,
      env: { HF_HUB_OFFLINE: '1' },
      idleMs: () => idleMs,
      onEvent: (msg) => { if (msg.event === 'ready') engine = { state: 'ready', loadMs: msg.ms }; },
      onLog: (text) => log?.info?.(`speakers: ${text.trim().slice(0, 400)}`),
      onExit: () => { if (sidecar === sc) { sidecar = null; engine = { state: 'idle' }; } },
    });
    sidecar = sc;
    return sc;
  }

  const inflight = new Map(); // `${owner}:${request}` -> cancel()
  // -> {dim, data: Uint8Array (float32 LE, dim per window), ms} | {cancelled} | {error, code}
  async function embed(owner, fileId, opts = {}) {
    const windows = opts.windows;
    if (!Array.isArray(windows) || windows.length > MAX_WINDOWS) return fail('badArgs', 'embed takes a list of windows');
    for (const w of windows) {
      if (!Array.isArray(w) || !Number.isSafeInteger(w[0]) || w[0] < 0 || !Number.isSafeInteger(w[1]) || w[1] <= 0 || w[1] > MAX_WINDOW) return fail('badArgs', 'a window is [offset, length] in samples, at most 30 s');
    }
    if (!runtimeReady() || !installed()) return fail('notInstalled', `${MODEL.name} is not installed`);
    const sound = await speech.sound(owner, fileId);
    if (!sound) return fail('notFound', 'no such sound file');
    const key = `${owner}:${opts.request}`;
    stats.embeds++;
    stats.windows += windows.length;
    const t0 = Date.now();
    if (fake) {
      let stop = false;
      inflight.set(key, () => { stop = true; });
      const out = new Float32Array(windows.length * FAKE_FREQS.length);
      for (let k = 0; k < windows.length; k++) {
        if (stop) break;
        out.set(fakeEmbedding(await sound.read(windows[k][0], windows[k][1])), k * FAKE_FREQS.length);
        if (fakeState.delay) await new Promise((r) => setTimeout(r, fakeState.delay));
      }
      inflight.delete(key);
      if (stop) { stats.cancelled++; return { cancelled: true }; }
      return { dim: FAKE_FREQS.length, data: new Uint8Array(out.buffer), ms: Date.now() - t0 };
    }
    const model = modelPath();
    const sc = startServer();
    const job = sc.send({ op: 'embed', model, file: sound.file, windows });
    inflight.set(key, () => sc.notify({ op: 'cancel', target: job.id }));
    const r = await job.reply;
    inflight.delete(key);
    if (r.cancelled) { stats.cancelled++; return { cancelled: true }; }
    if (r.error) return fail('model', r.error);
    const bytes = Buffer.from(String(r.embeddings || ''), 'base64');
    if (bytes.length !== windows.length * r.dim * 4) return fail('model', 'the embeddings do not match the windows');
    return { dim: r.dim, data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), ms: r.ms };
  }
  const cancel = (owner, request) => { inflight.get(`${owner}:${request}`)?.(); return true; };
  // A window that goes takes its embeddings with it (before speech.ownerGone deletes the sound they read).
  const ownerGone = (owner) => { for (const [k, stop] of inflight) if (k.startsWith(`${owner}:`)) stop(); };

  // ---------- setup: onnxruntime in the shared environment, then the model ----------
  let setupJob = null;
  let fakeCancel = null;
  async function setup(sender) {
    stats.setups++;
    const progress = (p) => { try { if (sender && !sender.isDestroyed?.()) sender.send('cut:speakersProgress', p); } catch {} };
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
    try {
      const need = (installed() ? 0 : MODEL.bytes) + (runtimeReady() ? 0 : RUNTIME_BYTES) + MARGIN;
      const free = Math.min(freeBytes(runtime.hfCacheDir()), runtimeReady() ? Infinity : freeBytes(runtime.dir));
      if (free < need) return { ok: false, code: 'disk', error: `${Math.ceil(need / 1e8) / 10} GB needed, ${Math.floor(free / 1e8) / 10} GB free`, need, free };
      if (!runtimeReady()) {
        progress({ phase: 'runtime', fraction: null });
        await runtime.exclusive(async () => {
          await runtime.ensureVenv(job, null, {});
          const missing = PACKAGES.filter((p) => !runtime.importable(p));
          if (missing.length) await runtime.pipInstall(job, missing.map((p) => p.replace('_', '-')));
        });
      }
      if (!installed()) {
        phase = 'download';
        progress({ phase: 'download', fraction: null, bytes: MODEL.bytes });
        const code = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(MODEL.repo)}, allow_patterns=${JSON.stringify(MODEL.files)})`;
        await job.run(runtime.python, ['-c', code]);
        if (!installed()) throw new Error(`${MODEL.name} was not downloaded completely`);
      }
      progress({ phase: 'done', fraction: 1 });
      return { ok: true };
    } catch (err) {
      const message = String(err?.message || err);
      return { ok: false, code: classify(`${message}\n${tail}`), error: message, log: tail.slice(-2000) };
    } finally {
      if (setupJob === job) setupJob = null;
    }
  }
  async function fakeSetupRun(progress) {
    let stop = false;
    fakeCancel = () => { stop = true; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 1; i <= 5; i++) {
        if (stop) return { ok: false, code: 'cancelled', error: 'Cancelled' };
        if (fakeSetup !== 'ok' && i === 3) return { ok: false, code: fakeSetup, error: `pretend failure: ${fakeSetup}` };
        progress({ phase: 'download', fraction: i / 5, bytes: MODEL.bytes });
        await wait(100);
      }
      fakeState.installed = true;
      progress({ phase: 'done', fraction: 1 });
      return { ok: true };
    } finally { fakeCancel = null; }
  }
  const cancelSetup = () => { setupJob?.cancel(); fakeCancel?.(); return true; };

  return {
    MODEL, status, embed, cancel, setup, cancelSetup, ownerGone,
    configure({ idleMinutes } = {}) { idleMs = runtime.idleMsOf(idleMinutes); sidecar?.idle(); return true; },
    async dispose() { if (sidecar?.alive()) await sidecar.kill(); },
    // fake only: delay (ms per window)
    testConfig(cfg = {}) {
      if (!fake) return false;
      if (Number.isFinite(cfg.delay)) fakeState.delay = Math.max(0, cfg.delay);
      return true;
    },
    get sidecarAlive() { return !!sidecar?.alive(); },
  };
}

function freeBytes(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch {}
    const up = path.dirname(d);
    if (up === d) return Infinity;
    d = up;
  }
}

module.exports = { createSpeakers, fakeEmbedding, MODEL };
