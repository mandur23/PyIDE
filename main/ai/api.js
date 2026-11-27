// The AI features' requests over an HTTP API instead of the Claude Code CLI (Settings › AI › Connection): the Anthropic
// Messages API with the user's API key, or any OpenAI-compatible Chat Completions server (OpenAI, Gemini, OpenRouter,
// Ollama on this PC) at the address the user gives. Both stream (server-sent events).
// No Electron here: main/ai/api-cli.js runs this as plain Node for the Rust Cut, which starts it in place of the CLI.
//
// cfg: {provider: 'anthropic' | 'openai', key, baseUrl?, model?}. The features ask for a Claude alias (haiku, sonnet,
// opus, fable) or a full Claude model id; Anthropic maps the alias to the current model, an OpenAI-compatible server
// always gets the one model the user set.
// Errors are ApiError with the CLI's codes: 'setup' (no key, address or model yet), 'auth', 'quota', 'cli', 'cancelled'.

const ANTHROPIC_URL = process.env.PYIDE_ANTHROPIC_URL || 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2026-10-21';
const ALIASES = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };
// A policy decline on these is answered again by the model the API picks, inside the same request.
const FALLBACK = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 64000;

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.via = 'api';
  }
}

const PROVIDERS = ['anthropic', 'openai'];
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// The model id a request goes to. -> string; throws ApiError('setup').
function modelOf(cfg, alias) {
  if (cfg.provider === 'openai') {
    if (!String(cfg.model || '').trim()) throw new ApiError('setup', 'No model is set for the OpenAI-compatible API (Settings › AI › Connection)');
    return String(cfg.model).trim();
  }
  if (ALIASES[alias]) return ALIASES[alias];
  if (/^claude-[\w.-]+$/.test(alias || '')) return alias;
  throw new ApiError('cli', `unknown model ${alias}`);
}

function check(cfg) {
  if (!cfg || !PROVIDERS.includes(cfg.provider)) throw new ApiError('setup', 'No API is set up (Settings › AI › Connection)');
  if (cfg.provider === 'anthropic' && !cfg.key) throw new ApiError('setup', 'No Anthropic API key is set (Settings › AI › Connection)');
  if (cfg.provider === 'openai' && !/^https?:\/\/[^\s/]+/i.test(trimUrl(cfg.baseUrl))) throw new ApiError('setup', 'No address is set for the OpenAI-compatible API (Settings › AI › Connection)');
}

// An HTTP failure as the code the features explain: a refused key, a rate or spending limit, or anything else.
function failure(status, body, host) {
  let message = '';
  try { const j = JSON.parse(body); message = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : ''); } catch {}
  message = String(message || body || '').trim().slice(0, 500) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ApiError('auth', `Authentication failed (${status}, ${host}): ${message}`);
  if (status === 429 || /credit balance|quota|billing|insufficient/i.test(message)) return new ApiError('quota', `Rate or spending limit (${status}, ${host}): ${message}`);
  return new ApiError('cli', `${host} answered ${status}: ${message}`);
}

// POSTs JSON and yields each server-sent event's data, parsed. Throws ApiError.
async function* events(url, headers, body, signal) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled');
    throw new ApiError('cli', `Cannot reach ${host}: ${err.cause?.message || err.message}`);
  }
  if (!res.ok) throw failure(res.status, await res.text().catch(() => ''), host);
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        yield msg;
      }
    }
  } catch (err) {
    if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled');
    if (err instanceof ApiError) throw err;
    throw new ApiError('cli', `The answer from ${host} broke off: ${err.message}`);
  }
}

// ---------- Anthropic ----------

// One Messages request. -> {blocks (the assistant content, to send back as it is), text, stopReason, usage}.
async function anthropicTurn({ cfg, model, system, messages, tools, signal, onText }) {
  const body = { model, max_tokens: MAX_TOKENS, system, messages, stream: true, cache_control: { type: 'ephemeral' } };
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } }));
  const headers = { 'x-api-key': cfg.key, 'anthropic-version': ANTHROPIC_VERSION };
  if (FALLBACK.has(model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }
  const blocks = [];
  const bad = new Set(); // tool calls whose input was not JSON: sent back as {}, answered with an error
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = null;
  const textOf = () => blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  for await (const ev of events(`${ANTHROPIC_URL}/messages`, headers, body, signal)) {
    if (ev.type === 'message_start') {
      const u = ev.message?.usage || {};
      usage.input = u.input_tokens || 0;
      usage.cacheRead = u.cache_read_input_tokens || 0;
      usage.cacheWrite = u.cache_creation_input_tokens || 0;
    } else if (ev.type === 'content_block_start') {
      const b = { ...ev.content_block };
      if (b.type === 'tool_use') { b.json = ''; b.input = {}; }
      blocks[ev.index] = b;
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      const d = ev.delta || {};
      if (!b) continue;
      if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; onText?.(textOf()); }
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') b.json += d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const b = blocks[ev.index];
      if (b?.type === 'tool_use') {
        try { b.input = b.json ? JSON.parse(b.json) : {}; } catch { b.input = {}; bad.add(b.id); }
        delete b.json;
      }
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason || stopReason;
      if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
    } else if (ev.type === 'error') {
      const e = ev.error || {};
      throw new ApiError(/rate_limit|overloaded/.test(e.type || '') ? 'quota' : 'cli', `Anthropic: ${e.message || e.type || 'stream error'}`);
    }
  }
  const all = blocks.filter(Boolean);
  if (stopReason === 'refusal') throw new ApiError('cli', 'Claude declined this request.');
  return { blocks: echoable(all), calls: callsAfterFallback(all).map((c) => (bad.has(c.id) ? { ...c, input: null } : c)), text: textOf(), stopReason, usage };
}

// After a fallback mid-answer, what came before the last fallback block goes back as text only (the API's rule for
// echoing such a turn); the fallback block stays where it was.
function echoable(blocks) {
  const last = blocks.map((b) => b.type).lastIndexOf('fallback');
  return last < 0 ? blocks : blocks.filter((b, i) => i >= last || b.type === 'text');
}
function callsAfterFallback(blocks) {
  const last = blocks.map((b) => b.type).lastIndexOf('fallback');
  return blocks.filter((b, i) => i > last && b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

// ---------- OpenAI-compatible ----------

async function openaiTurn({ cfg, model, messages, tools, signal, onText }) {
  const body = { model, messages, stream: true };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
  const headers = cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
  let text = '';
  const calls = [];
  let stopReason = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for await (const ev of events(`${trimUrl(cfg.baseUrl)}/chat/completions`, headers, body, signal)) {
    if (ev.error) throw new ApiError('cli', `${trimUrl(cfg.baseUrl)}: ${ev.error.message || JSON.stringify(ev.error)}`);
    if (ev.usage) { usage.input = ev.usage.prompt_tokens || usage.input; usage.output = ev.usage.completion_tokens || usage.output; }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) { text += d.content; onText?.(text); }
    for (const c of d.tool_calls || []) {
      const at = Number.isInteger(c.index) ? c.index : calls.length;
      const call = (calls[at] ||= { id: '', name: '', args: '' });
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      if (c.function?.arguments) call.args += c.function.arguments;
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }
  const parsed = calls.filter(Boolean).map((c, i) => {
    let input = null;
    try { input = c.args ? JSON.parse(c.args) : {}; } catch {}
    return { id: c.id || `call_${i}`, name: c.name, input, args: c.args || '{}' };
  });
  return { text, calls: parsed, stopReason, usage };
}

// ---------- requests ----------

// One answer, no tools. -> {text, ms}. onText(textSoFar) as it streams.
async function complete(cfg, { system, prompt, model, signal, onText }) {
  check(cfg);
  if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled');
  const id = modelOf(cfg, model);
  const started = Date.now();
  const r = cfg.provider === 'openai'
    ? await openaiTurn({ cfg, model: id, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], signal, onText })
    : await anthropicTurn({ cfg, model: id, system, messages: [{ role: 'user', content: prompt }], signal, onText });
  return { text: r.text, ms: Date.now() - started };
}

// A turn with tools: the model calls them until it answers. tools: [{name, description, inputSchema}];
// call(name, input) -> {text, isError, images?: [{data (base64), mimeType}]}. onEvent gets {type: 'turn'} as each request starts, {type: 'text', text} as it
// streams, {type: 'message', text, calls: [{id, name, input}]} once it ends and {type: 'result', id, ok, text} for each
// tool's answer.
// -> {ok, text, turns, maxTurns (true when it stopped there), usage: {input, output, cacheRead, cacheWrite}, model}.
async function agent(cfg, { system, prompt, model, tools, call, maxTurns = 80, signal, onEvent = () => {} }) {
  check(cfg);
  const id = modelOf(cfg, model);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const add = (u) => { for (const k of Object.keys(usage)) usage[k] += u[k] || 0; };
  const messages = cfg.provider === 'openai' ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  let last = '';
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled');
    onEvent({ type: 'turn' });
    const onText = (text) => onEvent({ type: 'text', text });
    const r = cfg.provider === 'openai'
      ? await openaiTurn({ cfg, model: id, messages, tools, signal, onText })
      : await anthropicTurn({ cfg, model: id, system, messages, tools, signal, onText });
    add(r.usage);
    last = r.text;
    onEvent({ type: 'message', text: r.text, calls: r.calls });
    if (!r.calls.length) return { ok: true, text: r.text, turns: turn, maxTurns: false, usage, model: id };
    const results = [];
    for (const c of r.calls) {
      let out;
      if (!c.input || typeof c.input !== 'object') out = { text: 'The tool input was not valid JSON. Call the tool again with valid JSON input.', isError: true };
      else {
        try { out = await call(c.name, c.input); } catch (err) { out = { text: String(err.message || err), isError: true }; }
      }
      if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled');
      onEvent({ type: 'result', id: c.id, ok: !out.isError, text: out.text });
      results.push({ c, out });
    }
    const said = (out) => out.text || (out.isError ? 'error' : 'ok');
    const pictures = (out) => (out.images || []).filter((p) => p?.data && /^image\/(png|jpeg|gif|webp)$/.test(p.mimeType || ''));
    if (cfg.provider === 'openai') {
      // A tool message holds text only: the pictures follow in a user message.
      messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const { c, out } of results) messages.push({ role: 'tool', tool_call_id: c.id, content: said(out) });
      const all = results.flatMap(({ out }) => pictures(out));
      if (all.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'The pictures the tool calls above returned:' }, ...all.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }))] });
    } else {
      messages.push({ role: 'assistant', content: r.blocks });
      messages.push({ role: 'user', content: results.map(({ c, out }) => ({
        type: 'tool_result', tool_use_id: c.id,
        content: [{ type: 'text', text: said(out) }, ...pictures(out).map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }))],
        ...(out.isError ? { is_error: true } : {}),
      })) });
    }
  }
  return { ok: false, text: last, turns: maxTurns, maxTurns: true, usage, model: id };
}

module.exports = { complete, agent, modelOf, ApiError, PROVIDERS, ALIASES, ANTHROPIC_URL };
