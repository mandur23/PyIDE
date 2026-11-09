// The AI assistant's turns (docs/cut-ai-control.md): one request of the chat panel (renderer/features/cut/
// ui-assistant.js) runs the Claude Code CLI (`claude -p`, main/ai/claude.js; PYIDE_CLAUDE_PATH points tests at a
// stand-in) connected to the Cut control server (main/cut/control.js) and to nothing else:
//   --tools ""              no built-in tool: no Bash, no file, no web tool
//   --strict-mcp-config     only the MCP server of --mcp-config, never the user's own servers
//   --allowedTools          exactly the Cut tools (mcp__cut__<name>), which run without asking
//   --permission-mode dontAsk   anything else is refused, never asked
// The MCP config (a file in the CLI's empty working directory, with this turn's token) goes when the turn ends.
//
// The CLI's stream-json lines become the page's events (cut:agentEvent {turn, type, ...}): 'text' (what Claude says,
// as it streams), 'tool' {id, name, input} when it calls a tool, 'result' {id, ok, text} when the tool answered, and
// last 'done' {ok, code, error, text, usage}. Codes: not-installed, auth, quota, cli, cancelled, timeout, badArgs.
// usage (null when the CLI ended without its result line, as on Stop) is what the result line reports: the tokens in
// (with the prompt cache's reads and writes apart), the tokens out, the CLI's cost estimate in US dollars, the time
// and the model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const claude = require('../ai/claude');

const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const PROMPT_LIMIT = 100000;
const SYSTEM_LIMIT = 20000;
const TIMEOUT_MS = 20 * 60 * 1000;
const MAX_TURNS = 80;
const ID = /^[\w.-]{1,64}$/;
const SERVER = 'cut';
const fail = (code, error) => ({ ok: false, code, error });
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

function usageOf(result, alias) {
  if (!result || typeof result !== 'object') return null;
  const u = result.usage && typeof result.usage === 'object' ? result.usage : {};
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
  const cost = Number(result.total_cost_usd);
  const out = {
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    output: count(u.output_tokens),
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    durationMs: count(result.duration_ms),
    turns: count(result.num_turns),
    model: alias,
    models,
  };
  return out.input || out.cacheRead || out.cacheWrite || out.output || out.costUsd !== null ? out : null;
}

function createAgent({ control, log, find = claude.findClaude, launch = claude.launch, kill = claude.killTree, timeoutMs = TIMEOUT_MS } = {}) {
  const running = new Map(); // `${owner}|${turn}` -> {child, token, stop}
  const tell = (wc, payload) => { try { if (wc && !wc.isDestroyed?.()) wc.send('cut:agentEvent', payload); } catch {} };

  async function run(owner, req, sender) {
    if (!req || typeof req !== 'object') return fail('badArgs', 'a turn is an object');
    const { turn, system, prompt } = req;
    const model = req.model || 'sonnet';
    if (typeof turn !== 'string' || !ID.test(turn)) return fail('badArgs', 'a turn needs an id');
    if (!MODELS.has(model)) return fail('badArgs', `unknown model ${model}`);
    if (typeof system !== 'string' || !system || system.length > SYSTEM_LIMIT) return fail('badArgs', 'the system prompt is missing or too long');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PROMPT_LIMIT) return fail('badArgs', 'the request is missing or too long');
    const key = `${owner}|${turn}`;
    if (running.has(key)) return fail('badArgs', 'that turn is running already');
    const bin = find();
    if (!bin) return fail('not-installed', 'Claude Code is not installed');
    const port = await control.start();
    if (!port) return fail('cli', 'the control server could not start');
    const names = control.toolNames();
    if (!names.length) return fail('cli', 'the editor has not listed its tools');

    const token = control.issue(turn, owner);
    const config = path.join(claude.WORK_DIR, `cut-mcp-${crypto.randomBytes(6).toString('hex')}.json`);
    const cleanup = () => { control.revoke(token); fs.promises.unlink(config).catch(() => {}); };
    try {
      fs.mkdirSync(claude.WORK_DIR, { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
    } catch (err) { cleanup(); return fail('cli', `cannot write the MCP settings: ${err.message}`); }
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', config,
      '--allowedTools', names.map((n) => `mcp__${SERVER}__${n}`).join(','), '--permission-mode', 'dontAsk',
      '--max-turns', String(MAX_TURNS), '--no-session-persistence', '--disable-slash-commands',
      '--system-prompt-file', claude.systemPromptFile(system),
    ];
    let child;
    try { child = launch(bin, args, { env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } }); } catch (err) { cleanup(); return fail(err.code || 'cli', err.message); }
    log?.info?.(`cut assistant ${turn}: ${prompt.length} characters, ${names.length} tools (${model})`);

    return new Promise((resolve) => {
      let ended = null; // why the turn stopped early: 'cancelled' | 'timeout'
      let result = null;
      let stderr = '';
      let buffer = '';
      let streamed = '';
      let sawDelta = false;
      const entry = { child, token, stop: (why) => { ended ??= why; control.revoke(token); kill(child); } };
      running.set(key, entry);
      const timer = setTimeout(() => entry.stop('timeout'), timeoutMs);
      const emit = (e) => tell(sender, { turn, ...e });
      const own = (n) => (typeof n === 'string' && n.startsWith(`mcp__${SERVER}__`) ? n.slice(SERVER.length + 7) : n);
      const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '');

      function handle(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev?.type === 'message_start') streamed = '';
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { sawDelta = true; streamed += ev.delta.text; emit({ type: 'text', text: streamed }); }
        } else if (msg.type === 'assistant') {
          const blocks = msg.message?.content || [];
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (text && !sawDelta) emit({ type: 'text', text });
          if (text) emit({ type: 'text', text, final: true });
          sawDelta = false;
          streamed = '';
          for (const b of blocks) if (b.type === 'tool_use') emit({ type: 'tool', id: String(b.id || ''), name: own(b.name), input: b.input && typeof b.input === 'object' ? b.input : {} });
        } else if (msg.type === 'user') {
          for (const b of msg.message?.content || []) {
            if (b?.type === 'tool_result') emit({ type: 'result', id: String(b.tool_use_id || ''), ok: !b.is_error, text: textOf(b.content).slice(0, 2000) });
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buffer += d;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handle(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      let spawnError = null;
      child.on('error', (err) => { spawnError = err; });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt, 'utf8');
      child.on('close', (code) => {
        clearTimeout(timer);
        running.delete(key);
        cleanup();
        if (buffer.trim()) handle(buffer.trim());
        let out;
        if (ended === 'cancelled') out = fail('cancelled', 'Stopped');
        else if (ended === 'timeout') out = fail('timeout', 'Claude Code did not finish in time');
        else if (spawnError) out = fail(spawnError.code === 'ENOENT' ? 'not-installed' : 'cli', spawnError.message);
        else if (result && !result.is_error && result.subtype === 'success') out = { ok: true, text: typeof result.result === 'string' ? result.result : '' };
        else {
          const message = (result && String(result.result || result.subtype || '')) || stderr.trim().split(/\r?\n/).slice(-3).join('\n') || `Claude Code exited with code ${code}`;
          out = fail(result?.subtype === 'error_max_turns' ? 'cli' : claude.classify(message), message);
        }
        out.usage = usageOf(result, model);
        emit({ type: 'done', ...out });
        resolve(out);
      });
    });
  }

  function stop(owner, turn) {
    const r = running.get(`${owner}|${turn}`);
    if (!r) return { ok: false };
    r.stop('cancelled');
    return { ok: true };
  }
  function ownerGone(owner) {
    for (const [k, r] of running) if (k.startsWith(`${owner}|`)) r.stop('cancelled');
  }
  return { run, stop, ownerGone, running: () => running.size, SERVER };
}

module.exports = { createAgent };
