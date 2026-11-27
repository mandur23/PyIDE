// The AI features over an HTTP API (main/ai/api.js) and the Rust Cut's stand-in CLI (main/ai/api-cli.js), against
// stand-in servers on 127.0.0.1: an Anthropic Messages API, an OpenAI-compatible Chat Completions API and the Cut
// control server's MCP endpoint. No request leaves this PC. Node only: node verify/ai-api-core.mjs
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let passed = 0, failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const S = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(path.join(tmpdir(), 'pyide-ai-api-'));

// ---------- stand-in servers ----------
const seen = { anthropic: [], openai: [], mcp: [] };
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => handler(req, res, body ? JSON.parse(body) : null));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const sse = (res, events, { gap = 0 } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  (async () => {
    for (const e of events) {
      if (res.destroyed) return;
      res.write(`event: ${e.type || 'message'}\ndata: ${typeof e === 'string' ? e : S(e)}\n\n`);
      if (gap) await sleep(gap);
    }
    res.end();
  })();
};

const anthropic = await listen((req, res, body) => {
  seen.anthropic.push({ headers: req.headers, body });
  const key = req.headers['x-api-key'];
  if (key === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(S({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
  if (key === 'limit') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(S({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } })); }
  const start = { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } };
  const stop = (reason, out) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: out } }, { type: 'message_stop' }];
  const text = (i, pieces) => [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
    ...pieces.map((t) => ({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } })), { type: 'content_block_stop', index: i }];
  if (key === 'slow') return sse(res, [start, ...text(0, Array.from({ length: 40 }, () => 'x'))], { gap: 50 });
  if (key === 'refuse') return sse(res, [start, ...stop('refusal', 1)]);
  if (!body.tools) return sse(res, [start, ...text(0, ['안녕', '하세요', '.']), ...stop('end_turn', 5)]);
  // With tools: a thinking block, then a call whose input arrives in pieces; after the tool's answer, the last text.
  const answered = body.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'));
  if (!answered) {
    return sse(res, [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
      { type: 'content_block_stop', index: 0 },
      ...text(1, ['Looking ', 'at it.']),
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'add_marker', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"time": 1' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '.5, "name": "A"}' } },
      { type: 'content_block_stop', index: 2 },
      ...stop('tool_use', 20)]);
  }
  return sse(res, [start, ...text(0, ['Added ', 'the marker.']), ...stop('end_turn', 7)]);
});

const openai = await listen((req, res, body) => {
  seen.openai.push({ headers: req.headers, body, url: req.url });
  if (req.headers.authorization === 'Bearer bad') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(S({ error: { message: 'Incorrect API key provided' } })); }
  const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
  if (!body.tools) return sse(res, [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hi ' }), chunk({ content: 'there' }), chunk({}, 'stop'), '[DONE]']);
  const answered = body.messages.some((m) => m.role === 'tool');
  if (!answered) {
    return sse(res, [chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'add_marker', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"time":2,' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"name":"B"}' } }] }), chunk({}, 'tool_calls'), '[DONE]']);
  }
  return sse(res, [chunk({ content: 'Done ' }), chunk({ content: 'with B.' }), chunk({}, 'stop'), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } }, '[DONE]']);
});

const TOKEN = 'turn-token-1';
const mcp = await listen((req, res, body) => {
  seen.mcp.push({ headers: req.headers, body });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
  if (body.id === undefined) { res.writeHead(202); return res.end(); }
  const reply = (result, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(S({ jsonrpc: '2.0', id: body.id, result })); };
  if (body.method === 'initialize') return reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, instructions: 'Use seconds for times.' }, { 'Mcp-Session-Id': 'sess-7' });
  if (body.method === 'tools/list') {
    return reply({ tools: [
      { name: 'add_marker', description: 'Adds a marker', inputSchema: { type: 'object', properties: { time: { type: 'number' }, name: { type: 'string' } }, required: ['time'] } },
      { name: 'delete_everything', description: 'Not allowed', inputSchema: { type: 'object', properties: {} } },
    ] });
  }
  if (body.method === 'tools/call') {
    return reply({ content: [{ type: 'text', text: `marker ${body.params.arguments.name} at ${body.params.arguments.time}` }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], isError: false });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(S({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } }));
});

process.env.PYIDE_ANTHROPIC_URL = `${anthropic.url}/v1`;
const api = require('../main/ai/api.js');
const A = (key) => ({ provider: 'anthropic', key });
const O = (key, model = 'llama3.2') => ({ provider: 'openai', key, baseUrl: `${openai.url}/v1/`, model });
const codeOf = async (p) => { try { await p; return 'ok'; } catch (err) { return `${err.code}${err.via === 'api' ? '' : ' (not via api)'}`; } };

try {
  // ---------- one answer ----------
  {
    const streamed = [];
    const r = await api.complete(A('sk-test'), { system: 'SYS', prompt: 'hello', model: 'sonnet', onText: (t) => streamed.push(t) });
    check(r.text === '안녕하세요.', `Anthropic: the streamed answer (${S(r.text)})`);
    check(S(streamed) === S(['안녕', '안녕하세요', '안녕하세요.']), `Anthropic: onText gets the text so far (${S(streamed)})`);
    const q = seen.anthropic.at(-1);
    check(q.headers['x-api-key'] === 'sk-test' && q.headers['anthropic-version'] === '2026-10-21', 'Anthropic: the key and the API version go in the headers');
    check(q.body.model === 'claude-sonnet-5-5' && q.body.stream === true && q.body.system === 'SYS' && q.body.messages[0].content === 'hello', `Anthropic: sonnet is claude-sonnet-5-5, streaming, system and prompt (${q.body.model})`);
    check(q.body.fallbacks === 'default' && q.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01', 'Anthropic: Sonnet asks for server-side fallbacks');
    check(q.body.max_tokens >= 16000 && q.body.cache_control?.type === 'ephemeral' && !('temperature' in q.body), 'Anthropic: room to answer, prompt caching, no sampling settings');
    await api.complete(A('sk-test'), { system: 's', prompt: 'p', model: 'haiku' });
    const h = seen.anthropic.at(-1);
    check(h.body.model === 'claude-haiku-5-5' && !('fallbacks' in h.body) && !h.headers['anthropic-beta'], 'Anthropic: haiku is claude-haiku-5-5, without fallbacks');
    await api.complete(A('sk-test'), { system: 's', prompt: 'p', model: 'claude-opus-4-8' });
    check(seen.anthropic.at(-1).body.model === 'claude-opus-4-8', 'Anthropic: a full model id is sent as it is');
  }
  {
    const streamed = [];
    const r = await api.complete(O('ok-key'), { system: 'SYS', prompt: 'hello', model: 'opus', onText: (t) => streamed.push(t) });
    check(r.text === 'Hi there' && S(streamed) === S(['Hi ', 'Hi there']), `OpenAI-compatible: the streamed answer (${S(r.text)})`);
    const q = seen.openai.at(-1);
    check(q.url === '/v1/chat/completions' && q.headers.authorization === 'Bearer ok-key', `OpenAI-compatible: /chat/completions under the address, the key as a bearer token (${q.url})`);
    check(q.body.model === 'llama3.2' && S(q.body.messages) === S([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }]), 'OpenAI-compatible: the one model set, whatever the feature asked; system then user');
    await api.complete(O(''), { system: 's', prompt: 'p', model: 'haiku' });
    check(!('authorization' in seen.openai.at(-1).headers), 'OpenAI-compatible: no key, no authorization header (Ollama)');
  }

  // ---------- failures ----------
  check(await codeOf(api.complete(A('bad'), { system: 's', prompt: 'p', model: 'sonnet' })) === 'auth', 'a refused Anthropic key is auth');
  check(await codeOf(api.complete(A('limit'), { system: 's', prompt: 'p', model: 'sonnet' })) === 'quota', 'Anthropic 429 is quota');
  check(await codeOf(api.complete(O('bad'), { system: 's', prompt: 'p', model: 'sonnet' })) === 'auth', 'a refused OpenAI-compatible key is auth');
  check(await codeOf(api.complete(A(''), { system: 's', prompt: 'p', model: 'sonnet' })) === 'setup', 'no Anthropic key is setup');
  check(await codeOf(api.complete(O('k', ''), { system: 's', prompt: 'p', model: 'sonnet' })) === 'setup', 'no OpenAI-compatible model is setup');
  check(await codeOf(api.complete({ provider: 'openai', baseUrl: '', model: 'm' }, { system: 's', prompt: 'p', model: 'sonnet' })) === 'setup', 'no OpenAI-compatible address is setup');
  check(await codeOf(api.complete(A('refuse'), { system: 's', prompt: 'p', model: 'haiku' })) === 'cli', 'a refusal is a failure, not an empty answer');
  check(await codeOf(api.complete({ provider: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm' }, { system: 's', prompt: 'p', model: 'sonnet' })) === 'cli', 'an address nobody answers is cli');
  {
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 300);
    const code = await codeOf(api.complete(A('slow'), { system: 's', prompt: 'p', model: 'sonnet', signal: ctl.signal }));
    check(code === 'cancelled' && Date.now() - started < 1500, `an abort ends a streaming answer at once as cancelled (${code}, ${Date.now() - started} ms)`);
  }
  {
    let msg = '';
    try { await api.complete(A('bad'), { system: 's', prompt: 'p', model: 'sonnet' }); } catch (err) { msg = err.message; }
    check(!msg.includes('bad') || msg.includes('invalid x-api-key'), 'the error names the server\'s reason, not the key');
  }

  // ---------- a turn with tools ----------
  for (const [label, cfg] of [['Anthropic', A('sk-test')], ['OpenAI-compatible', O('ok-key')]]) {
    const events = [];
    const calls = [];
    const r = await api.agent(cfg, {
      system: 'SYS', prompt: 'add a marker', model: 'sonnet',
      tools: [{ name: 'add_marker', description: 'Adds a marker', inputSchema: { type: 'object', properties: {} } }],
      call: async (name, input) => { calls.push({ name, input }); return { text: 'ok, added', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }; },
      onEvent: (e) => events.push(e),
    });
    const want = label === 'Anthropic' ? { time: 1.5, name: 'A' } : { time: 2, name: 'B' };
    check(S(calls) === S([{ name: 'add_marker', input: want }]), `${label}: the tool is called once with the streamed input (${S(calls)})`);
    check(r.ok && r.text === (label === 'Anthropic' ? 'Added the marker.' : 'Done with B.') && r.turns === 2, `${label}: the answer after the tool's result, two requests (${S(r.text)}, ${r.turns})`);
    check(events.filter((e) => e.type === 'turn').length === 2 && events.some((e) => e.type === 'result' && e.ok && e.text === 'ok, added'), `${label}: events for each request and the tool's result`);
    if (label === 'Anthropic') {
      const second = seen.anthropic.at(-1).body;
      const echoed = second.messages[1].content;
      check(echoed[0].type === 'thinking' && echoed[0].signature === 'SIG123' && echoed[2].type === 'tool_use' && !('json' in echoed[2]) && S(echoed[2].input) === S(want),
        'Anthropic: the assistant turn goes back whole (thinking with its signature, the call with its parsed input)');
      const result = second.messages[2].content[0];
      check(result.type === 'tool_result' && result.tool_use_id === 'toolu_1' && result.content[1]?.type === 'image' && result.content[1].source.media_type === 'image/png', 'Anthropic: the tool result carries its text and picture');
      check(r.usage.input === 22 && r.usage.output === 27 && r.usage.cacheRead === 6, `Anthropic: usage adds up over the requests (${S(r.usage)})`);
    } else {
      const second = seen.openai.at(-1).body;
      check(second.messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_9') && second.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_9'), 'OpenAI-compatible: the call and its tool message go back');
      check(second.messages.at(-1).role === 'user' && second.messages.at(-1).content.some((c) => c.type === 'image_url'), 'OpenAI-compatible: the picture follows in a user message');
      check(Array.isArray(second.tools) && second.tools[0].type === 'function' && second.tools[0].function.name === 'add_marker', 'OpenAI-compatible: tools as functions');
    }
  }
  {
    const r = await api.agent(A('sk-test'), { system: 's', prompt: 'p', model: 'sonnet', maxTurns: 1, tools: [{ name: 'add_marker' }], call: async () => ({ text: 'ok' }) });
    check(!r.ok && r.maxTurns, 'a turn that keeps calling tools stops at max turns');
  }

  // ---------- the Rust Cut's stand-in CLI ----------
  const CLI = path.join(process.cwd(), 'main', 'ai', 'api-cli.js');
  const sysFile = path.join(work, 'system.txt');
  writeFileSync(sysFile, 'CUT SYSTEM');
  function cli(args, prompt, conn, key) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PYIDE_AI_CONNECTION: S(conn), PYIDE_AI_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stdin.end(prompt);
      child.on('close', (code) => resolve({ code, lines: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
    });
  }
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--max-turns', '1', '--safe-mode', '--no-session-persistence', '--system-prompt-file', sysFile];
  {
    const r = await cli(['--model', 'haiku', ...base], 'polish these captions', { provider: 'anthropic' }, 'sk-test');
    const deltas = r.lines.filter((l) => l.type === 'stream_event').map((l) => l.event.delta.text).join('');
    const result = r.lines.at(-1);
    check(deltas === '안녕하세요.' && result.type === 'result' && result.subtype === 'success' && !result.is_error && result.result === '안녕하세요.', `CLI: text deltas then the result line, as claude -p writes them (${S(result)})`);
    const q = seen.anthropic.at(-1).body;
    check(q.system === 'CUT SYSTEM' && q.messages[0].content === 'polish these captions' && q.model === 'claude-haiku-5-5', 'CLI: the system prompt file and stdin are the request');
  }
  {
    const r = await cli(['--model', 'sonnet', ...base], 'x', { provider: 'anthropic' }, 'bad');
    const result = r.lines.at(-1);
    check(result.is_error && /authentication/i.test(result.result), `CLI: a refused key is a result error the Cut reads as sign-in (${S(result.result)})`);
    const lim = (await cli(['--model', 'sonnet', ...base], 'x', { provider: 'anthropic' }, 'limit')).lines.at(-1);
    check(lim.is_error && /rate.?limit/i.test(lim.result), `CLI: a rate limit reads as the usage limit (${S(lim.result)})`);
  }
  {
    const config = path.join(work, 'mcp.json');
    writeFileSync(config, S({ mcpServers: { cut: { type: 'http', url: `${mcp.url}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
    for (const [label, conn, key] of [['Anthropic', { provider: 'anthropic' }, 'sk-test'], ['OpenAI-compatible', { provider: 'openai', baseUrl: `${openai.url}/v1`, model: 'qwen3' }, 'ok-key']]) {
      seen.mcp.length = 0;
      const before = (label === 'Anthropic' ? seen.anthropic : seen.openai).length;
      const r = await cli(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--mcp-config', config,
        '--allowedTools', 'mcp__cut__add_marker', '--permission-mode', 'dontAsk', '--max-turns', '80', '--no-session-persistence', '--disable-slash-commands', '--system-prompt-file', sysFile], 'add a marker', conn, key);
      const types = r.lines.map((l) => l.type);
      const tool = r.lines.find((l) => l.type === 'assistant' && l.message.content.some((c) => c.type === 'tool_use'));
      const result = r.lines.at(-1);
      check(types.includes('stream_event') && types.includes('user') && result.subtype === 'success' && !result.is_error, `CLI ${label}: the assistant's turn as stream-json (${S([...new Set(types)])})`);
      check(tool?.message.content.find((c) => c.type === 'tool_use').name === 'mcp__cut__add_marker', 'CLI: tool calls are named mcp__cut__<tool>, as the Cut expects');
      const asked = seen.mcp.filter((m) => m.body.method === 'tools/call');
      check(asked.length === 1 && asked[0].headers['mcp-session-id'] === 'sess-7', `CLI: the tool runs on the control server with its session (${asked.length})`);
      const sent = (label === 'Anthropic' ? seen.anthropic : seen.openai).slice(before);
      const tools = label === 'Anthropic' ? sent[0].body.tools.map((t) => t.name) : sent[0].body.tools.map((t) => t.function.name);
      check(S(tools) === S(['add_marker']), `CLI: only the allowed tools are offered (${S(tools)})`);
      const sys = label === 'Anthropic' ? sent[0].body.system : sent[0].body.messages[0].content;
      check(sys.startsWith('CUT SYSTEM') && sys.includes('Use seconds for times.'), 'CLI: the server\'s instructions follow the system prompt');
      const userLine = r.lines.find((l) => l.type === 'user').message.content[0];
      check(userLine.type === 'tool_result' && !userLine.is_error && userLine.content[0].text === (label === 'Anthropic' ? 'marker A at 1.5' : 'marker B at 2'), 'CLI: the tool\'s answer is a user tool_result line');
      check(result.usage && Number.isFinite(result.usage.output_tokens) && result.num_turns === 2, `CLI: the result line has usage and the number of requests (${S(result.usage)})`);
    }
  }
  check(!S(seen).includes('api.anthropic.com') && !S(seen).includes('openai.com'), 'nothing went to a real API');
} finally {
  for (const s of [anthropic, openai, mcp]) s.server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
