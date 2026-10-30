// A notebook kernel on a Colab runtime, run with ELECTRON_RUN_AS_NODE. It speaks the JSON lines of
// renderer/features/notebook/kernel_bridge.py (requests {op, ...} on stdin, events {ev, ...} on stdout), so the notebook
// drives it the same way. The first request is {op: 'connect', url, token}: the runtime's Jupyter server, reached
// with the short-lived proxy token in X-Colab-Runtime-Proxy-Token (renewed by {op: 'token'}). The kernel is started
// through the Jupyter REST API and its channels run over one WebSocket; connect with kernelId reattaches to a kernel
// kept from before (its variables intact), and {op: 'detach'} leaves the kernel running. google.colab's requests to
// Colab's web page (colab_request on iopub) go to the notebook as {ev: 'colab'} and are answered with {op: 'colabReply'}.
// {op: 'upload', path} writes a local file into the runtime's working directory through the kernel.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEADER = 'X-Colab-Runtime-Proxy-Token';
const session = crypto.randomUUID();
let base = '';
let token = '';
let kernelId = null;
let ws = null;
let queue = []; // requests waiting for the kernel
let ready = false;
let closing = false;
let reconnects = 0;
const requests = new Map(); // kernel msg_id -> [kind, our id]
let lastExec = null;

const emit = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const fatal = (message) => { emit({ ev: 'fatal', kind: 'start', message }); process.exit(0); };

async function rest(method, rel, body) {
  const res = await fetch(`${base}/api/${rel}`, {
    method,
    headers: { [HEADER]: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${method} /api/${rel}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function message(channel, type, content) {
  const msgId = crypto.randomUUID();
  ws.send(JSON.stringify({
    header: { msg_id: msgId, msg_type: type, username: 'pyide', session, date: new Date().toISOString(), version: '5.3' },
    parent_header: {}, metadata: {}, content, channel, buffers: [],
  }));
  return msgId;
}

function open() {
  const url = `${base.replace(/^http/, 'ws')}/api/kernels/${kernelId}/channels?session_id=${session}`;
  ws = new WebSocket(url, { headers: { [HEADER]: token } });
  ws.onopen = () => {
    reconnects = 0;
    if (!ready) requests.set(message('shell', 'kernel_info_request', {}), ['info', null]);
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(String(e.data))); } catch (err) { emit({ ev: 'log', text: String(err) }); } };
  // The proxy drops idle sockets; a fresh token gets a new one. Three failures in a row: the kernel is gone. A refused
  // handshake (a runtime Colab took back answers 403) fires only error in Electron's Node, a dropped socket only close.
  let lost = false;
  const onLost = () => {
    if (lost || closing) return;
    lost = true;
    if (++reconnects > 3) { dead(); return; }
    setTimeout(open, 1000 * reconnects);
  };
  ws.onclose = onLost;
  ws.onerror = onLost;
}

// Requests the kernel will not answer: cells end as dead, the bridge's own (an upload) give up.
function dropRequests() {
  for (const [kind, rid] of requests.values()) {
    if (kind === 'execute') emit({ ev: 'done', id: rid, status: 'dead', n: null });
    else if (kind === 'internal') rid(null);
  }
  requests.clear();
}

function dead() {
  dropRequests();
  emit({ ev: 'dead' });
}

const owner = (msg) => requests.get(msg.parent_header?.msg_id)?.[1] ?? lastExec;
// Output of the bridge's own silent requests (evaluate, upload) is not a cell's.
const internal = (msg) => { const kind = requests.get(msg.parent_header?.msg_id)?.[0]; return !!kind && kind !== 'execute'; };

function onMessage(msg) {
  const type = msg.header?.msg_type || msg.msg_type;
  const content = msg.content || {};
  const channel = msg.channel;
  if (channel === 'iopub') {
    if (type === 'colab_request') {
      const meta = msg.metadata || {};
      if (meta.colab_msg_id !== undefined) emit({ ev: 'colab', id: owner(msg), type: meta.colab_request_type || '', msgId: meta.colab_msg_id, request: content.request ?? null });
      return;
    }
    if (internal(msg) && type !== 'status') return;
    if (type === 'status') {
      if (content.execution_state === 'dead') { dead(); return; }
      emit({ ev: 'status', state: content.execution_state });
    } else if (type === 'execute_input') emit({ ev: 'count', id: owner(msg), n: content.execution_count });
    else if (type === 'stream') emit({ ev: 'output', id: owner(msg), output: { output_type: 'stream', name: content.name || 'stdout', text: content.text || '' } });
    else if (type === 'error') emit({ ev: 'output', id: owner(msg), output: { output_type: 'error', ename: content.ename || '', evalue: content.evalue || '', traceback: content.traceback || [] } });
    else if (type === 'display_data' || type === 'execute_result') {
      const output = { output_type: type, data: content.data || {}, metadata: content.metadata || {} };
      if (type === 'execute_result') output.execution_count = content.execution_count;
      emit({ ev: 'output', id: owner(msg), output, display_id: content.transient?.display_id ?? null });
    } else if (type === 'update_display_data') emit({ ev: 'update', display_id: content.transient?.display_id ?? null, data: content.data || {}, metadata: content.metadata || {} });
    else if (type === 'clear_output') emit({ ev: 'clear', id: owner(msg), wait: !!content.wait });
  } else if (channel === 'shell') {
    const entry = requests.get(msg.parent_header?.msg_id);
    if (!entry) return;
    requests.delete(msg.parent_header.msg_id);
    const [kind, rid] = entry;
    if (kind === 'info') {
      ready = true;
      emit({ ev: 'ready', python: `Colab (${base.replace(/^https?:\/\//, '').split('/')[0]})`, version: content.language_info?.version || '', kernelId });
      const waiting = queue;
      queue = [];
      for (const cmd of waiting) handle(cmd);
    } else if (kind === 'execute') emit({ ev: 'done', id: rid, status: content.status, n: content.execution_count });
    else if (kind === 'internal') rid(content);
    else emit({ ev: 'reply', id: rid, content });
  } else if (channel === 'stdin' && type === 'input_request') {
    emit({ ev: 'stdin', id: owner(msg), prompt: content.prompt || '', password: !!content.password });
  }
}

async function connect(cmd) {
  base = String(cmd.url || '').replace(/\/+$/, '');
  token = String(cmd.token || '');
  if (!/^https?:\/\//.test(base)) fatal('The Colab runtime has no address');
  try {
    // A kept kernel still running on the runtime is reattached to; a gone one (the runtime restarted) is replaced.
    if (cmd.kernelId) kernelId = (await rest('GET', `kernels/${encodeURIComponent(cmd.kernelId)}`).catch(() => null))?.id || null;
    kernelId ||= (await rest('POST', 'kernels', { name: 'python3' })).id;
  } catch (err) { fatal(`The Colab runtime did not start a kernel: ${err.message}`); }
  open();
}

// A silent execute_request whose reply resolves the promise.
const run = (code) => new Promise((resolve) => {
  requests.set(message('shell', 'execute_request', { code, silent: true, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: false }), ['internal', resolve]);
});

// The file in pieces small enough for one message each, appended in order, into the kernel's working directory
// (/content on Colab) under its own name.
const CHUNK = 512 * 1024;
async function upload({ id, path: file }) {
  const name = path.basename(String(file));
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    let at = 0;
    do {
      const n = fs.readSync(fd, buf, 0, CHUNK, at);
      const mode = at ? 'ab' : 'wb';
      const reply = await run(`import base64 as _b\nwith open(${JSON.stringify(name)}, '${mode}') as _f: _f.write(_b.b64decode('${buf.subarray(0, n).toString('base64')}'))\ndel _b, _f`);
      if (reply?.status !== 'ok') throw new Error(`${reply?.ename || 'Error'}: ${reply?.evalue || 'the runtime could not write the file'}`);
      at += n;
      emit({ ev: 'upload', id, name, done: at, size });
    } while (at < size);
    emit({ ev: 'reply', id, content: { ok: true, name, size } });
  } catch (err) {
    emit({ ev: 'reply', id, content: { ok: false, name, error: err.message } });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function handle(cmd) {
  const { op, id } = cmd;
  if (op === 'connect') return connect(cmd);
  if (op === 'token') { token = String(cmd.token || token); return undefined; }
  if (op === 'shutdown') return shutdown();
  if (op === 'detach') return shutdown({ keepKernel: true });
  if (!ready) { queue.push(cmd); return undefined; }
  if (op === 'execute') {
    requests.set(message('shell', 'execute_request', { code: cmd.code, silent: false, store_history: true, user_expressions: {}, allow_stdin: true, stop_on_error: true }), ['execute', id]);
    lastExec = id;
  } else if (op === 'complete') requests.set(message('shell', 'complete_request', { code: cmd.code, cursor_pos: cmd.pos }), ['complete', id]);
  else if (op === 'inspect') requests.set(message('shell', 'inspect_request', { code: cmd.code, cursor_pos: cmd.pos, detail_level: cmd.detail || 0 }), ['inspect', id]);
  else if (op === 'evaluate') {
    requests.set(message('shell', 'execute_request', { code: '', silent: true, store_history: false, user_expressions: { r: cmd.expr }, allow_stdin: false, stop_on_error: false }), ['evaluate', id]);
  } else if (op === 'input') message('stdin', 'input_reply', { value: cmd.value ?? '' });
  else if (op === 'colabReply') {
    // google.colab reads its answer from stdin: an input_reply whose value is the colab_reply.
    message('stdin', 'input_reply', { value: { type: 'colab_reply', colab_msg_id: cmd.msgId, ...(cmd.error ? { error: String(cmd.error) } : { data: cmd.data ?? null }) } });
  } else if (op === 'upload') return upload(cmd);
  else if (op === 'interrupt') rest('POST', `kernels/${kernelId}/interrupt`).catch((err) => emit({ ev: 'log', text: err.message }));
  else if (op === 'restart') {
    for (const [kind, rid] of requests.values()) if (kind === 'internal') rid(null);
    requests.clear();
    rest('POST', `kernels/${kernelId}/restart`).then(() => emit({ ev: 'restarted' }), (err) => { emit({ ev: 'log', text: err.message }); dead(); });
  }
  return undefined;
}

async function shutdown({ keepKernel = false } = {}) {
  closing = true;
  try { ws?.close(); } catch { /* closing anyway */ }
  if (kernelId && !keepKernel) await rest('DELETE', `kernels/${kernelId}`).catch(() => {});
  process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { emit({ ev: 'log', text: `bad request: ${line.slice(0, 200)}` }); continue; }
    Promise.resolve(handle(cmd)).catch((err) => emit({ ev: 'log', text: String(err?.message || err) }));
  }
});
process.stdin.on('end', () => shutdown());
