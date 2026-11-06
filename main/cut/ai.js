// Text AI for Nano Studio Cut (docs/cut-architecture.md section 7): one Claude request at a time per call, through the
// Claude Code CLI helper (main/ai/claude.js; PYIDE_CLAUDE_PATH points tests at a stand-in, 'none' simulates a missing
// install). Cut mode does not load the ai-* plugins, so the channels live here: cut:aiStatus, cut:aiComplete,
// cut:aiCancel.
//
// The renderer builds the prompt (renderer/features/cut/ai.js) from text only: transcript words, caption text, clip and
// marker names with their times. Nothing here reads a file or a media byte; this module checks the request's shape and
// sizes, runs it with a time limit, streams how much has arrived (cut:aiProgress) and answers with a value, never a
// throw: {ok: true, text, ms} or {ok: false, code: 'not-installed' | 'auth' | 'cli' | 'cancelled' | 'timeout' |
// 'badArgs', error}.
const claude = require('../ai/claude');

const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const PROMPT_LIMIT = 200000; // characters; the renderer condenses long transcripts well below this
const SYSTEM_LIMIT = 20000;
const TIMEOUT_MS = 180000;
const PROGRESS_MS = 100;
const ID = /^[\w.-]{1,64}$/;
const fail = (code, error) => ({ ok: false, code, error });

function createAi({ log, complete = claude.complete, find = claude.findClaude, timeoutMs = TIMEOUT_MS } = {}) {
  const running = new Map(); // `${owner}|${request}` -> {owner, ctl}
  const stats = { requests: 0, cancelled: 0 };
  const tell = (wc, channel, payload) => { try { if (wc && !wc.isDestroyed?.()) wc.send(channel, payload); } catch {} };

  const status = () => ({ installed: !!find(), stats: { ...stats, running: running.size } });

  async function run(owner, req, sender) {
    if (!req || typeof req !== 'object') return fail('badArgs', 'a request is an object');
    const { request, task = 'request', system, prompt } = req;
    const model = req.model || 'sonnet';
    if (typeof request !== 'string' || !ID.test(request)) return fail('badArgs', 'a request needs an id');
    if (typeof task !== 'string' || !ID.test(task)) return fail('badArgs', 'a task is a short name');
    if (!MODELS.has(model)) return fail('badArgs', `unknown model ${model}`);
    if (typeof system !== 'string' || !system || system.length > SYSTEM_LIMIT) return fail('badArgs', 'the system prompt is missing or too long');
    if (typeof prompt !== 'string' || !prompt || prompt.length > PROMPT_LIMIT) return fail('badArgs', 'the prompt is missing or too long');
    const key = `${owner}|${request}`;
    if (running.has(key)) return fail('badArgs', 'that request is running already');
    const ctl = new AbortController();
    running.set(key, { owner, ctl });
    stats.requests++;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    let last = 0;
    const onText = (text) => {
      const now = Date.now();
      if (now - last < PROGRESS_MS) return;
      last = now;
      tell(sender, 'cut:aiProgress', { request, chars: text.length });
    };
    log?.info?.(`claude ${task}: ${prompt.length} characters sent (${model})`);
    try {
      const r = await complete({ system, prompt, model, signal: ctl.signal, onText });
      return { ok: true, text: String(r.text ?? ''), ms: r.ms };
    } catch (err) {
      if (timedOut) return fail('timeout', 'Claude Code did not answer in time');
      if (err?.code === 'cancelled') stats.cancelled++;
      return fail(typeof err?.code === 'string' ? err.code : 'cli', String(err?.message || err));
    } finally {
      clearTimeout(timer);
      running.delete(key);
    }
  }

  function cancel(owner, request) {
    const r = running.get(`${owner}|${request}`);
    if (!r) return { ok: false };
    r.ctl.abort();
    return { ok: true };
  }
  // A window that goes takes its requests with it.
  function ownerGone(owner) {
    for (const r of running.values()) if (r.owner === owner) r.ctl.abort();
  }
  return { status, run, cancel, ownerGone, MODELS: [...MODELS] };
}

module.exports = { createAi, PROMPT_LIMIT };
