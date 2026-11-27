// The Claude Code CLI's place for the Rust Cut when an API is chosen (Settings › AI › Connection): run as Node by
// nano-studio-api.cmd (main/ai/connection.js's cliShim), it takes the arguments the Cut gives `claude -p`
// (cut-rs/crates/cut-app/src/ai/claude.rs, agent.rs), answers through main/ai/api.js and writes the CLI's stream-json
// lines: stream_event text deltas, assistant and user messages with the tool calls and their results, the result line.
// With --mcp-config it is the AI assistant's turn: the tools are the Cut control server's (MCP over HTTP, its token in
// the config's headers), only those --allowedTools names, called until the model answers.
// The connection comes in the environment: PYIDE_AI_CONNECTION {provider, baseUrl, model} and the key PYIDE_AI_KEY,
// both removed from this process's environment once read.
const fs = require('fs');
const api = require('./api');

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function argsOf(argv) {
  const out = { allowed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--model') out.model = next();
    else if (a === '--system-prompt-file') out.systemFile = next();
    else if (a === '--mcp-config') out.mcpConfig = next();
    else if (a === '--allowedTools') out.allowed = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-turns') out.maxTurns = Number(next());
    else if (a === '--tools' || a === '--output-format' || a === '--permission-mode') next();
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

// An MCP client over Streamable HTTP for one server: initialize, tools/list, tools/call.
function mcpClient({ url, headers = {} }) {
  let session = '';
  let id = 0;
  async function rpc(method, params, notify = false) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
    });
    session = res.headers.get('mcp-session-id') || session;
    if (notify) return null;
    const text = await res.text();
    const data = /text\/event-stream/i.test(res.headers.get('content-type') || '')
      ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() : text;
    let msg;
    try { msg = JSON.parse(data); } catch { throw new Error(`the Cut control server answered ${res.status}: ${text.slice(0, 200)}`); }
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }
  return {
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude', version: '1' } });
      await rpc('notifications/initialized', {}, true);
      return r?.instructions || '';
    },
    async tools() { return (await rpc('tools/list', {}))?.tools || []; },
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const content = r?.content || [];
      const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
      const images = content.filter((c) => c?.type === 'image').map((c) => ({ data: c.data, mimeType: c.mimeType }));
      return { text, images, isError: !!r?.isError };
    },
  };
}

async function main() {
  const a = argsOf(process.argv.slice(2));
  let cfg = null;
  try { cfg = JSON.parse(process.env.PYIDE_AI_CONNECTION || 'null'); } catch {}
  if (cfg) cfg.key = process.env.PYIDE_AI_KEY || '';
  delete process.env.PYIDE_AI_KEY;
  delete process.env.PYIDE_AI_CONNECTION;
  const started = Date.now();
  const prompt = await readStdin();
  const finish = (result) => { write({ type: 'result', duration_ms: Date.now() - started, total_cost_usd: null, ...result }); };
  const failed = (err) => finish({ subtype: 'error_during_execution', is_error: true, result: String(err?.message || err) });
  let system = '';
  try { system = a.systemFile ? fs.readFileSync(a.systemFile, 'utf8') : ''; } catch (err) { return failed(err); }
  const usageLine = (u) => ({ input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite });

  if (!a.mcpConfig) {
    try {
      const r = await api.complete(cfg, {
        system, prompt, model: a.model || 'sonnet',
        onText: (() => { let sent = 0; return (t) => { write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t.slice(sent) } } }); sent = t.length; }; })(),
      });
      return finish({ subtype: 'success', is_error: false, result: r.text, num_turns: 1 });
    } catch (err) { return failed(err); }
  }

  let server;
  try {
    const config = JSON.parse(fs.readFileSync(a.mcpConfig, 'utf8'));
    const [name, s] = Object.entries(config.mcpServers || {})[0] || [];
    if (!s?.url) throw new Error('the MCP settings name no server');
    server = { name, client: mcpClient({ url: s.url, headers: s.headers }) };
  } catch (err) { return failed(err); }
  const prefix = `mcp__${server.name}__`;
  let tools;
  try {
    const instructions = await server.client.init();
    if (instructions) system += `\n\n# MCP Server Instructions\n\n## ${server.name}\n${instructions}`;
    tools = (await server.client.tools())
      .filter((t) => !a.allowed || a.allowed.includes(prefix + t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  } catch (err) { return failed(err); }

  let sent = 0;
  try {
    const r = await api.agent(cfg, {
      system, prompt, model: a.model || 'sonnet', tools, maxTurns: Number.isFinite(a.maxTurns) && a.maxTurns > 0 ? a.maxTurns : 80,
      call: (name, input) => server.client.call(name, input),
      onEvent(e) {
        if (e.type === 'turn') { sent = 0; write({ type: 'stream_event', event: { type: 'message_start' } }); }
        else if (e.type === 'text') { write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: e.text.slice(sent) } } }); sent = e.text.length; }
        else if (e.type === 'message') {
          const content = [...(e.text ? [{ type: 'text', text: e.text }] : []), ...e.calls.map((c) => ({ type: 'tool_use', id: c.id, name: prefix + c.name, input: c.input || {} }))];
          write({ type: 'assistant', message: { role: 'assistant', content } });
        } else if (e.type === 'result') {
          write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, is_error: !e.ok, content: [{ type: 'text', text: e.text }] }] } });
        }
      },
    });
    const common = { num_turns: r.turns, usage: usageLine(r.usage), modelUsage: { [r.model]: {} } };
    if (r.maxTurns) return finish({ subtype: 'error_max_turns', is_error: true, result: '', ...common });
    return finish({ subtype: 'success', is_error: false, result: r.text, ...common });
  } catch (err) { return failed(err); }
}

main().then(() => { process.exitCode = 0; }, (err) => { write({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err?.message || err) }); process.exitCode = 1; });
