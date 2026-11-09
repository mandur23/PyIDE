// The Cut control server (docs/cut-ai-control.md): the editor's tools (renderer/features/cut/control.js) offered to an
// AI over MCP's Streamable HTTP transport on 127.0.0.1. A JSON-RPC request is a POST to /mcp and its answer is the
// response body (application/json); there is no server-sent stream, so GET and DELETE answer 405.
//
// Who may call: a request needs `Authorization: Bearer <token>`, compared in constant time. A token is either one
// chat turn's (issue(), handed to the Claude Code CLI that main/cut/agent.js starts, revoked when the turn ends or
// stops) or the external one, which exists only while the user allows external AIs (setExternal(true)) and is kept in
// <userData>/cut-control.json with the port, so a client set up once keeps working; disconnect() replaces it. A request
// with an Origin header (a web page) or another Host is refused before the token is read, so a page in a browser
// cannot reach the editor through DNS rebinding.
//
// The server checks the request's shape and the tool's name; the tool runs in the page (callRenderer: cut:controlCall
// out, cut:controlResult back), which checks the arguments and answers {content, isError}. A page that reloads or
// closes answers its calls here, as errors. Nothing in this file reads a project or media file.
//
// Long calls (automation jobs, a dialog waiting for the user): an MCP client gives up on an HTTP request after a
// while (Claude Code: 60 s), and it sees no progress meanwhile. So a call never holds its request longer than holdMs:
// one still running then answers {running: true, job, progress, step, elapsed_s} and keeps running in the page, and the
// tool wait_job (this file's own, listed after the page's) waits up to holdMs again for that job's answer or says how
// far it is. The page reports progress with cut:controlProgress. While a client's job runs, its other calls are
// refused (the page runs calls one at a time anyway). A job belongs to the client that started it; a turn's jobs go
// with its token.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PROTOCOL = '2025-06-18';
const BODY_LIMIT = 1024 * 1024;
const CALL_LIMIT_MS = 15 * 60 * 1000; // without an answer or progress from the page this long, a call fails
const HOLD_MS = 25 * 1000;
const WAIT_TOOL = 'wait_job';
const SESSION_IDLE_MS = 10 * 60 * 1000;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;

const token = () => crypto.randomBytes(24).toString('hex');
const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const envHold = Number(process.env.PYIDE_CUT_HOLD_MS);
const DEFAULT_HOLD = Number.isFinite(envHold) && envHold >= 200 ? envHold : HOLD_MS;

function createControl({ configFile = null, log = null, version = '0', now = Date.now, holdMs = DEFAULT_HOLD } = {}) {
  const holdS = Math.round(holdMs / 1000);
  const waitTool = {
    name: WAIT_TOOL,
    description: `Waits for a job: a tool call that ran longer than ${holdS} s answered {running: true, job, progress} and goes on running on this PC. wait_job waits up to ${holdS} s more and answers that tool's own result when it ends, or {running: true, progress (0..1, or null when the job does not measure it), step, elapsed_s} while it runs; call it again until the job ends. Never start the tool again for a job that runs. The user sees the progress and can stop it.`,
    inputSchema: { type: 'object', properties: { job: { type: 'string', description: 'The job from the running answer.', maxLength: 40 } }, required: ['job'], additionalProperties: false },
    annotations: { title: 'Wait for a job', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
  let server = null;
  let port = null;
  let listening = null;
  let tools = []; // [{name, description, inputSchema, annotations}], from the page
  let instructions = '';
  let target = null; // (channel, payload) -> sends to the page; set by the window
  const turns = new Map(); // token -> {turn, owner}
  let external = null; // {token} while allowed
  const sessions = new Map(); // session id -> {kind, name, seen}
  const pending = new Map(); // call id -> the call (callRenderer)
  const jobs = new Map(); // job id -> a call that outlasted holdMs, until its answer is handed over
  let seq = 0;
  const listeners = new Set();
  const stats = { refused: 0, calls: 0 };

  const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
  const writeConfig = (cfg) => {
    if (!configFile) return;
    try {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      const tmp = `${configFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg));
      fs.renameSync(tmp, configFile);
    } catch (err) { log?.warn?.(`cut control: cannot save its settings: ${err.message}`); }
  };

  // ---------- who is connected ----------
  const connected = () => {
    const t = now();
    for (const [id, s] of sessions) if (t - s.seen > SESSION_IDLE_MS) sessions.delete(id);
    return [...sessions.values()].filter((s) => s.kind === 'external').map((s) => ({ name: s.name, since: s.since }));
  };
  const changed = () => { const list = connected(); for (const fn of listeners) { try { fn({ external: list }); } catch {} } };
  const sweep = setInterval(() => { const before = sessions.size; connected(); if (sessions.size !== before) changed(); }, 30000);
  sweep.unref?.();

  function clientOf(req) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) return null;
    for (const [t, info] of turns) if (sameToken(m[1], t)) return { kind: 'chat', turn: info.turn, owner: info.owner };
    if (external && sameToken(m[1], external.token)) return { kind: 'external' };
    return null;
  }

  // ---------- calls the page answers ----------
  // -> the call {id, name, client, started, progress: {fraction, text} | null, result: null until answered, done:
  // Promise of the answer}. CALL_LIMIT_MS counts from the last sign of life (the call, its progress).
  function callRenderer(name, args, client) {
    const id = ++seq;
    const call = { id, name, client, started: now(), progress: null, result: null };
    call.done = new Promise((resolve) => {
      const fail = () => call.resolve({ content: [{ type: 'text', text: 'The editor did not answer in time.' }], isError: true });
      call.alive = () => { clearTimeout(call.timer); call.timer = setTimeout(fail, CALL_LIMIT_MS); };
      call.resolve = (result) => { if (call.result) return; clearTimeout(call.timer); pending.delete(id); call.result = result; resolve(result); };
    });
    call.alive();
    pending.set(id, call);
    if (!target || !target('cut:controlCall', { id, name, args, client })) call.resolve({ content: [{ type: 'text', text: 'The Nano Studio Cut window is not open.' }], isError: true });
    return call;
  }
  // The page's progress of a call: {id, fraction (0..1), text}.
  function progress(msg) {
    const call = pending.get(msg?.id);
    if (!call) return;
    const f = Number(msg.fraction);
    call.progress = { fraction: Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : null, text: typeof msg.text === 'string' ? msg.text.slice(0, 200) : '' };
    call.alive();
  }
  const sameClient = (a, b) => a.kind === b.kind && (a.kind !== 'chat' || (a.turn === b.turn && a.owner === b.owner));
  const jobOf = (client) => [...jobs.values()].find((j) => sameClient(j.client, client)) || null;
  const listed = () => (tools.length ? [...tools, waitTool] : tools);
  const dropJobs = (match) => { for (const [id, j] of jobs) if (match(j.client)) jobs.delete(id); };
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
  function running(call) {
    const p = call.progress;
    return text(JSON.stringify({
      running: true, job: `job${call.id}`, tool: call.name,
      progress: p?.fraction ?? null, step: p?.text || null, elapsed_s: Math.round((now() - call.started) / 1000),
      note: `Still running on this PC; the user sees its progress. Call ${WAIT_TOOL} with this job until it ends (each call waits up to ${holdS} s). Do not start ${call.name} again; other tools are refused until it ends.`,
    }));
  }
  // The call's answer if it comes within holdMs, else its running answer (and it becomes a job).
  async function hold(call) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), holdMs); });
    const r = await Promise.race([call.done, late]);
    clearTimeout(timer);
    if (r) { jobs.delete(`job${call.id}`); return r; }
    jobs.set(`job${call.id}`, call);
    return running(call);
  }
  function waitJob(args, client) {
    const id = typeof args.job === 'string' ? args.job : '';
    const call = jobs.get(id);
    if (!call || !sameClient(call.client, client)) {
      const mine = jobOf(client);
      return text(mine ? `There is no job ${id || '(none given)'}; the running job is ${`job${mine.id}`} (${mine.name}).` : `There is no running job ${id || '(none given)'}; its answer was given already, or it never ran longer than ${holdS} s.`, true);
    }
    return hold(call);
  }
  // The page's answer: {id, result: {content, isError}}.
  function answer(msg) {
    const call = pending.get(msg?.id);
    if (!call) return;
    const r = msg.result;
    const content = Array.isArray(r?.content) ? r.content.filter((x) => x && (x.type === 'text' || x.type === 'image')).slice(0, 8) : [];
    call.resolve({ content: content.length ? content : [{ type: 'text', text: 'No answer.' }], isError: !!r?.isError });
  }
  // A page that went away answers nothing: its calls end as errors.
  function abandon() {
    for (const call of [...pending.values()]) call.resolve(text('The Nano Studio Cut window was reloaded or closed.', true));
  }

  // ---------- JSON-RPC ----------
  async function rpc(msg, client, res, sessionId) {
    const { id, method, params = {} } = msg || {};
    const reply = (body, headers = {}) => send(res, 200, body, headers);
    const result = (r, headers) => reply({ jsonrpc: '2.0', id, result: r }, headers);
    const error = (code, message) => reply({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (typeof method !== 'string') return error(-32600, 'Invalid request');
    if (id === undefined) { send(res, 202, null); return undefined; }
    if (method === 'initialize') {
      const sid = token();
      sessions.set(sid, { kind: client.kind, name: String(params?.clientInfo?.name || (client.kind === 'chat' ? 'Claude' : 'AI')).slice(0, 80), since: now(), seen: now() });
      if (client.kind === 'external') changed();
      return result({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Nano Studio Cut', version },
        instructions,
      }, { 'Mcp-Session-Id': sid });
    }
    if (sessionId && sessions.has(sessionId)) sessions.get(sessionId).seen = now();
    if (method === 'ping') return result({});
    if (method === 'tools/list') return result({ tools: listed() });
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string' || !listed().some((t) => t.name === name)) return error(-32602, `Unknown tool ${name}`);
      const args = params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'arguments must be an object');
      stats.calls++;
      if (name === WAIT_TOOL) return result(await waitJob(args, client));
      const busy = jobOf(client);
      if (busy) {
        const pct = busy.progress?.fraction != null ? ` (${Math.round(busy.progress.fraction * 100)}%)` : '';
        return result(text(`job${busy.id} (${busy.name}) is still running${pct}. Call ${WAIT_TOOL} with job "job${busy.id}" until it ends; nothing else runs before it.`, true));
      }
      return result(await hold(callRenderer(name, args, client)));
    }
    return error(-32601, `Method not found: ${method}`);
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    if (body == null) { res.writeHead(status, headers); res.end(); return; }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }
  const refuse = (res, status, message) => { stats.refused++; send(res, status, { error: message }); };

  function onRequest(req, res) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(res, 403, 'Wrong host.');
    if (req.headers.origin) return refuse(res, 403, 'Web pages may not call Nano Studio Cut.');
    const url = (req.url || '').split('?')[0];
    if (url !== '/mcp') return refuse(res, 404, 'Not found.');
    const client = clientOf(req);
    if (!client) { res.setHeader('WWW-Authenticate', 'Bearer'); return refuse(res, 401, 'A valid token is needed.'); }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return refuse(res, 405, 'Only POST.'); }
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > BODY_LIMIT) { refuse(res, 413, 'Too large.'); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', async () => {
      if (size > BODY_LIMIT) return;
      let msg;
      try { msg = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (Array.isArray(msg)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } });
      const sid = String(req.headers['mcp-session-id'] || '');
      try { await rpc(msg, client, res, sid); } catch (err) {
        log?.warn?.(`cut control: ${err?.message || err}`);
        send(res, 500, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: 'Internal error' } });
      }
    });
  }

  // ---------- the server ----------
  function start() {
    if (listening) return listening;
    listening = new Promise((resolve) => {
      const cfg = readConfig();
      const listen = (p) => {
        server = http.createServer(onRequest);
        server.on('error', (err) => {
          if (p && err.code === 'EADDRINUSE') { server = null; listen(0); return; }
          log?.warn?.(`cut control: the server failed: ${err.message}`);
          resolve(null);
        });
        server.listen(p, '127.0.0.1', () => {
          port = server.address().port;
          if (cfg.port !== port) writeConfig({ ...readConfig(), port });
          resolve(port);
        });
      };
      listen(Number.isInteger(cfg.port) && cfg.port > 1024 && cfg.port < 65536 ? cfg.port : 0);
    });
    return listening;
  }

  const api = {
    start,
    get port() { return port; },
    setTarget(fn) { target = fn; },
    setTools(list, text = '') {
      if (!Array.isArray(list)) return { ok: false };
      tools = list.filter((t) => t && NAME.test(t.name) && typeof t.description === 'string' && t.inputSchema && typeof t.inputSchema === 'object').slice(0, 200)
        .map((t) => ({ name: t.name, description: t.description.slice(0, 4000), inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) }));
      instructions = String(text || '').slice(0, 8000);
      return { ok: true, count: tools.length };
    },
    toolNames: () => listed().map((t) => t.name),
    // A chat turn's token, good until revoke().
    issue(turn, owner) {
      const t = token();
      turns.set(t, { turn, owner });
      return t;
    },
    revoke(t) {
      const info = turns.get(t);
      turns.delete(t);
      if (info) dropJobs((c) => c.kind === 'chat' && c.turn === info.turn && c.owner === info.owner);
    },
    // Allow or stop external AIs. -> {on, url, token} | {on: false}
    async setExternal(on) {
      if (!on) {
        external = null;
        dropJobs((c) => c.kind === 'external');
        for (const [id, s] of sessions) if (s.kind === 'external') sessions.delete(id);
        changed();
        return { on: false };
      }
      const p = await start();
      if (!p) return { on: false, error: 'The control server could not start.' };
      const cfg = readConfig();
      if (!external) {
        external = { token: typeof cfg.token === 'string' && /^[0-9a-f]{48}$/.test(cfg.token) ? cfg.token : token() };
        if (cfg.token !== external.token) writeConfig({ ...cfg, port: p, token: external.token });
      }
      return { on: true, url: `http://127.0.0.1:${p}/mcp`, token: external.token };
    },
    // Ends the external AI's sessions and replaces its token, so it cannot come back with the old one.
    async disconnect() {
      if (!external) return { on: false };
      external = { token: token() };
      dropJobs((c) => c.kind === 'external');
      writeConfig({ ...readConfig(), port, token: external.token });
      for (const [id, s] of sessions) if (s.kind === 'external') sessions.delete(id);
      changed();
      return { on: true, url: `http://127.0.0.1:${port}/mcp`, token: external.token };
    },
    connected,
    onClients(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    answer,
    progress,
    abandon,
    stats: () => ({ ...stats, pending: pending.size, turns: turns.size, jobs: jobs.size }),
    close() {
      clearInterval(sweep);
      abandon();
      server?.close();
      server = null;
      listening = null;
    },
  };
  return api;
}

module.exports = { createControl, PROTOCOL, WAIT_TOOL };
