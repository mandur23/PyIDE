// A stand-in for the Claude Code CLI in the Rust editor's tests (never the real Claude): a test writes claude.cmd
// beside a scenario.json and points PYIDE_CLAUDE_PATH (or the runner's switch) at the .cmd, which runs this script
// with FAKE_CLAUDE_DIR set to that folder.
//
// Each run appends to calls.jsonl what it was started with: its arguments, working folder, stdin, the environment
// switches the editor sets, the text of the --system-prompt-file and the --mcp-config file (read while it runs).
// scenario.json says what the n-th run (from 0) does: { "runs": [run, ...] } (the last one repeats), each run
//   { "answer": "text" }                       a completion streamed in pieces, then a successful result line
//   { "lines": [ {...}, ... ] }                these stream-json lines as they are (an assistant turn)
//   { "error": "message" }                     a result line with is_error
//   { "stderr": "text", "exit": 2 }             no result: that stderr and exit code
//   { "mcp": [{ "name", "arguments" }], "answer" }   these tools called through the server of --mcp-config, then the
//                                              answer (an assistant turn that edits)
//   { "sleepMs": 5000 }                        waits first (time limits and Stop), then does the rest of the run
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const read = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8') : null);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const callsFile = path.join(dir, 'calls.jsonl');
const n = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length : 0;
const mcpConfig = read(after('--mcp-config'));
appendFileSync(callsFile, `${JSON.stringify({
  args, cwd: process.cwd(), stdin,
  disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
  system: read(after('--system-prompt-file')), mcpConfig,
})}\n`);

const runs = JSON.parse(read(path.join(dir, 'scenario.json')) || '{"runs":[{}]}').runs;
const run = runs[Math.min(n, runs.length - 1)] || {};
if (run.sleepMs) await sleep(run.sleepMs);
if (run.mcp) {
  // calls the editor's tools as a model would: through the server and with the token of --mcp-config
  const server = JSON.parse(mcpConfig).mcpServers.cut;
  let k = 0;
  for (const c of run.mcp) {
    const id = `tu${++k}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__cut__${c.name}`, input: c.arguments }] } });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...server.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: k, method: 'tools/call', params: { name: c.name, arguments: c.arguments } }),
    }).then((r) => r.json());
    const r = res.result || { content: [{ type: 'text', text: res.error?.message || 'no answer' }], isError: true };
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!r.isError, content: r.content }] } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: run.answer ?? 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: run.answer ?? 'Done.', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.002, duration_ms: 900, num_turns: run.mcp.length + 1 });
} else if (run.lines) {
  for (const l of run.lines) { out(l); await sleep(run.stepMs || 0); }
} else if (run.error !== undefined) {
  out({ type: 'result', subtype: 'success', is_error: true, result: run.error });
} else if (run.stderr !== undefined) {
  process.stderr.write(run.stderr);
  process.exitCode = run.exit ?? 1;
} else {
  const text = String(run.answer ?? '');
  for (let i = 0; i < text.length; i += 40) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 40) } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001, duration_ms: 1200, num_turns: 1 });
}
