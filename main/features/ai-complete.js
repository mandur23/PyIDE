// AI code completion ("Tab"): fill-in-the-middle with a local Qwen2.5-Coder model.
// The model runs on llama.cpp in a Python sidecar (main/ai/complete_server.py) inside the shared AI runtime
// (main/ai/runtime.js). PYIDE_AI_COMPLETE_BACKEND=fake swaps in a deterministic rule table for tests.
const fs = require('fs');
const path = require('path');
const runtime = require('../ai/runtime');
const { plan, trimCompletion } = require('../ai/complete-text');

// Q8_0 GGUF conversions (ggml-org) of Qwen's Apache-2.0 base coder models; Q8_0 is near lossless and decodes about
// six times faster on CPU than the float32 transformers model.
const MODELS = [
  { id: 'qwen2.5-coder-0.5b', name: 'Qwen2.5-Coder 0.5B', size: '531 MB', repo: 'ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF',
    file: 'qwen2.5-coder-0.5b-q8_0.gguf', homepage: 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B' },
  { id: 'qwen2.5-coder-1.5b', name: 'Qwen2.5-Coder 1.5B', size: '1.6 GB', repo: 'ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF',
    file: 'qwen2.5-coder-1.5b-q8_0.gguf', homepage: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B' },
];
// A prebuilt CPU wheel: building llama.cpp from source needs a C++ toolchain most users do not have.
const LLAMA_CPP = ['llama-cpp-python==0.3.36', '--only-binary=:all:', '--extra-index-url', 'https://abetlen.github.io/llama-cpp-python/whl/cpu'];

// The fake model: the first rule whose pattern matches the end of the prefix answers, as raw model output that
// still goes through trimming.
const FAKE_RULES = [
  [/def greet\(name\):\n {4}$/, 'return f"Hello, {name}!"\n\n\ndef unrelated():\n    pass'],
  [/def area\(w, h\):\n {4}$/, 'return w * h'],
  [/result = $/, 'compute_total(items, tax=0.1)'],
  [/total = add\($/, '1, 2)'],
  [/ratio = \(a - b\) \/ \(a$/, ' + b) if a + b else 0'],
  [/for i in range\(3\):$/, '\n    total += i\n    print(total)\n\nprint("done")'],
  [/print\("hello$/, ', world")'],
  [/# say hello$/, ' to everyone'],
  [/def half\(x\):\n\n$/, '    return x / 2'],
];

exports.register = ({ ipcMain, app, send, appDir }) => {
  const fake = process.env.PYIDE_AI_COMPLETE_BACKEND === 'fake';
  const server = path.join(appDir, 'main', 'ai', 'complete_server.py');
  const modelOf = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
  const modelFile = (m) => runtime.hfCachedFile(m.repo, m.file);
  const runtimeReady = () => runtime.pythonReady() && runtime.hasPackage('llama_cpp');

  let engine = { state: 'idle', model: null, error: null }; // idle | loading | ready | error
  const stats = { requests: 0, completed: 0, cancelled: 0, errors: 0, latencies: [] };
  const status = () => ({
    backend: fake ? 'fake' : 'llama.cpp',
    runtime: fake || runtimeReady(),
    models: MODELS.map((m) => ({ id: m.id, name: m.name, size: m.size, homepage: m.homepage, installed: fake || (runtimeReady() && !!modelFile(m)) })),
    engine,
  });
  const pushStatus = () => send('ai-complete:status', status());
  const setEngine = (e) => { engine = { ...engine, ...e }; pushStatus(); };

  // ---------- backends: start(request) -> {reply: Promise<{text}|{cancelled}|{error}>, cancel()} ----------
  const fakeConfig = { delay: 0 };
  const fakeBackend = {
    start(req) {
      let timer;
      let settle;
      const reply = new Promise((resolve) => {
        settle = resolve;
        const rule = FAKE_RULES.find(([re]) => re.test(req.prefix));
        timer = setTimeout(() => resolve({ text: rule ? rule[1] : '' }), fakeConfig.delay);
      });
      return { reply, cancel: () => { clearTimeout(timer); settle({ cancelled: true }); } };
    },
  };

  let sidecar = null;
  function startServer() {
    if (sidecar?.alive()) return sidecar;
    sidecar = runtime.startSidecar({
      script: server,
      onEvent: (msg) => {
        if (msg.event === 'loading') setEngine({ state: 'loading', error: null });
        else if (msg.event === 'ready') setEngine({ state: 'ready', error: null, loadMs: msg.ms });
      },
      onLog: (text) => send('ai-complete:log', { model: engine.model, text }),
      onExit: (code) => setEngine({ state: engine.state === 'ready' ? 'idle' : 'error', model: null, error: engine.state === 'ready' ? null : `completion server exited (${code})` }),
    });
    return sidecar;
  }
  const llamaBackend = {
    start(req) {
      const m = modelOf(req.model);
      const file = modelFile(m);
      if (!runtimeReady() || !file) return { reply: Promise.resolve({ error: `${m.name} is not installed` }), cancel() {} };
      const sc = startServer();
      if (engine.model !== m.id) setEngine({ model: m.id });
      const { id, reply } = sc.send({ ...req, op: 'complete', model: file });
      return { reply, cancel: () => sc.notify({ op: 'cancel', target: id }) };
    },
  };
  const backend = fake ? fakeBackend : llamaBackend;

  // ---------- requests ----------
  const inflight = new Map(); // `${webContents id}:${request id}` -> job
  ipcMain.handle('ai-complete:complete', async (e, { id, prefix, suffix, path: file, language, context, multiline, model, repo }) => {
    const key = `${e.sender.id}:${id}`;
    const shape = plan({ prefix, suffix, multiline });
    const started = Date.now();
    stats.requests++;
    const job = backend.start({ prefix, suffix, path: file, language, context: context || [], repo, model, maxTokens: shape.maxTokens,
      stop: shape.stop, indent: shape.indent, blankIndent: shape.blankIndent });
    inflight.set(key, job);
    const r = await job.reply;
    inflight.delete(key);
    if (r.cancelled) { stats.cancelled++; return { id, cancelled: true }; }
    if (r.error) {
      stats.errors++;
      // A server that exits reports itself through onExit; a deliberate stop is not an error.
      if (!/server exited|not running/.test(r.error)) setEngine({ error: r.error });
      return { id, error: r.error };
    }
    if (engine.error) setEngine({ error: null });
    const ms = Date.now() - started;
    stats.completed++;
    stats.latencies.push(ms);
    if (stats.latencies.length > 500) stats.latencies.shift();
    return { id, ...trimCompletion(r.text, { prefix, suffix, ...shape }), ms };
  });
  ipcMain.handle('ai-complete:cancel', (e, id) => inflight.get(`${e.sender.id}:${id}`)?.cancel());
  ipcMain.handle('ai-complete:status', () => status());
  ipcMain.handle('ai-complete:stats', () => stats);
  ipcMain.handle('ai-complete:testConfig', (_e, cfg) => { if (fake) Object.assign(fakeConfig, cfg); return fake; });

  // ---------- setup: shared runtime, llama.cpp, model download ----------
  const jobs = new Map(); // model id -> setup job
  ipcMain.handle('ai-complete:setup', async (_e, { model: modelId, interpreter } = {}) => {
    if (fake) return { ok: true };
    const m = modelOf(modelId);
    const job = runtime.createJob((text) => send('ai-complete:log', { model: m.id, text }));
    jobs.set(m.id, job);
    try {
      await runtime.exclusive(async () => {
        await runtime.ensureVenv(job, interpreter);
        if (!runtime.hasPackage('llama_cpp')) await runtime.pipInstall(job, LLAMA_CPP);
        if (!runtime.hasPackage('huggingface_hub')) await runtime.pipInstall(job, ['huggingface_hub']);
      });
      if (!modelFile(m)) await runtime.hfDownload(job, m.repo, [m.file]);
      pushStatus();
      return { ok: true };
    } catch (err) {
      pushStatus();
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (jobs.get(m.id) === job) jobs.delete(m.id);
    }
  });
  ipcMain.handle('ai-complete:cancelSetup', (_e, modelId) => jobs.get(modelOf(modelId).id)?.cancel());
  // Removes only the model; the shared runtime stays for the other AI features.
  ipcMain.handle('ai-complete:remove', async (_e, modelId) => {
    const m = modelOf(modelId);
    // The server maps the model file, and Windows cannot delete it while it is open.
    if (sidecar?.alive()) await sidecar.kill();
    fs.rmSync(runtime.hfRepoDir(m.repo), { recursive: true, force: true });
    pushStatus();
    return true;
  });

  app.on('before-quit', () => sidecar?.kill());
};
