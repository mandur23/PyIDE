// Notebooks on Colab runtimes (main/notebook/colab.js, main/notebook/colab-bridge.js, the notebook's kernel menu)
// against a stand-in Google: its token endpoint (the gcloud login's refresh token), the Colab API (subscription,
// runtime specs, runtimes and their operations) and each runtime's Jupyter server, whose kernel speaks Jupyter
// messages over a WebSocket and only answers requests that carry the runtime's proxy token. The sign-in runs a
// stand-in gcloud, which appears only after the notebook has offered to install it. Port 9675.
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-colab-'));
const adc = path.join(work, 'application_default_credentials.json');
const sdk = path.join(work, 'sdk');
const gcloud = path.join(sdk, 'gcloud.cmd');
const at = (name) => path.join(sdk, name);
mkdirSync(sdk);
writeFileSync(at('adc.json'), S({ type: 'authorized_user', client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-secret', refresh_token: 'test-refresh-token' }));
// Prints the sign-in page as gcloud does, then waits (touching "alive") until the test writes "go", as the browser would.
const fakeGcloud = ['@echo off', 'echo %*> "%~dp0args.txt"', 'echo Your browser has been opened to visit: 1>&2',
  'echo     https://accounts.google.com/o/oauth2/auth?response_type=code^&client_id=test-client 1>&2',
  ':wait', 'echo.> "%~dp0alive"', 'if exist "%~dp0go" goto done', 'ping -n 2 127.0.0.1 >nul', 'goto wait',
  ':done', 'copy /y "%~dp0adc.json" "%GOOGLE_APPLICATION_CREDENTIALS%" >nul', 'echo Credentials saved to file: [%GOOGLE_APPLICATION_CREDENTIALS%] 1>&2', ''].join('\r\n');
const idToken = ['{}', S({ email: 'ada@example.com' }), ''].map((p) => Buffer.from(p).toString('base64url')).join('.');
const seen = { tokens: [], released: [], restarts: 0, interrupts: 0, gets: 0, wsTokens: [], colabReplies: [], files: {}, uploadChunks: 0, kernelStarts: 0, kernelDeletes: 0 };
const runtimes = new Map(); // id -> {spec, tokens: [current], sockets, kernel: {count, vars, colabIds} while one runs}
// One-shot errors the stand-in answers with next: fault.subscription, fault.create = [status, {error}].
const fault = {};

// A WebSocket server is a few lines: the handshake, and unfragmented text frames (masked from the client).
function wsAccept(req, socket) {
  const key = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  const send = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : null;
    socket.write(Buffer.concat([head, data]));
  };
  let buf = Buffer.alloc(0);
  const handlers = [];
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let at = 2;
      if (len === 126) { len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const body = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(at + 4 + len);
      if (op === 8) { socket.end(); return; }
      if (op === 1) for (const h of handlers) h(JSON.parse(body.toString()));
    }
  });
  socket.on('error', () => {});
  return { send, onMessage: (h) => handlers.push(h) };
}

// The stand-in kernel: kernel_info, execute (print, a value, an error, input(), "name = value" and "name" against
// variables that live as long as the kernel, not the socket), complete; google.colab's userdata.get and drive.mount
// as colab_request on iopub answered on stdin; and the bridge's silent uploads, kept in seen.files.
function kernel(ws, k) {
  let waitingInput = null;
  let waitingColab = null;
  const reply = (parent, channel, type, content, metadata = {}) => ws.send({ channel, header: { msg_id: crypto.randomUUID(), msg_type: type }, parent_header: parent.header, content, metadata });
  ws.onMessage((msg) => {
    const type = msg.header.msg_type;
    if (type === 'kernel_info_request') reply(msg, 'shell', 'kernel_info_reply', { status: 'ok', language_info: { name: 'python', version: '3.12.11' } });
    else if (type === 'complete_request') reply(msg, 'shell', 'complete_reply', { status: 'ok', matches: ['print', 'property'], cursor_start: 0, cursor_end: msg.content.cursor_pos });
    else if (type === 'input_reply' && msg.content.value?.type === 'colab_reply') {
      seen.colabReplies.push(msg.content.value);
      if (waitingColab?.id === msg.content.value.colab_msg_id) { const done = waitingColab.done; waitingColab = null; done(msg.content.value); }
    } else if (type === 'input_reply' && waitingInput) { const done = waitingInput; waitingInput = null; done(msg.content.value); }
    else if (type === 'execute_request') {
      const code = msg.content.code;
      const finish = (status, n = null) => {
        reply(msg, 'iopub', 'status', { execution_state: 'idle' });
        reply(msg, 'shell', 'execute_reply', { status, execution_count: n });
      };
      reply(msg, 'iopub', 'status', { execution_state: 'busy' });
      if (msg.content.silent) {
        const up = /open\(("[^"]*"), '(wb|ab)'\)[\s\S]*b64decode\('([^']*)'\)/.exec(code);
        if (up) {
          const name = JSON.parse(up[1]);
          const data = Buffer.from(up[3], 'base64');
          seen.files[name] = up[2] === 'ab' ? Buffer.concat([seen.files[name] || Buffer.alloc(0), data]) : data;
          seen.uploadChunks++;
        }
        finish('ok');
        return;
      }
      const n = ++k.count;
      reply(msg, 'iopub', 'execute_input', { code, execution_count: n });
      const out = (text) => reply(msg, 'iopub', 'stream', { name: 'stdout', text });
      const fail = (ename, evalue) => { reply(msg, 'iopub', 'error', { ename, evalue, traceback: [`${ename}: ${evalue}`] }); finish('error', n); };
      const ask = (requestType, request, done) => {
        const id = ++k.colabIds;
        waitingColab = { id, done };
        reply(msg, 'iopub', 'colab_request', { request }, { colab_request_type: requestType, colab_msg_id: id });
      };
      const secret = /userdata\.get\('(\w+)'\)/.exec(code);
      const assign = /^(\w+) = (.+)$/.exec(code.trim());
      if (secret) {
        ask('GetSecret', { key: secret[1] }, (r) => {
          if (!r.data?.exists) fail('SecretNotFoundError', `Secret ${secret[1]} does not exist.`);
          else if (!r.data.access) fail('NotebookAccessError', `Notebook does not have access to secret ${secret[1]}`);
          else { out(`secret: ${r.data.payload}\n`); finish('ok', n); }
        });
      } else if (code.includes('drive.mount(')) {
        ask('request_auth', { authType: 'dfs_ephemeral' }, (r) => (r.error ? fail('MessageError', r.error) : (out('Mounted at /content/drive\n'), finish('ok', n))));
      } else if (code.includes('input(')) {
        reply(msg, 'stdin', 'input_request', { prompt: 'Your name? ', password: false });
        waitingInput = (value) => { out(`hi ${value}\n`); finish('ok', n); };
      } else if (code.includes('raise')) {
        fail('ValueError', 'on colab');
      } else if (assign) {
        k.vars[assign[1]] = assign[2];
        finish('ok', n);
      } else if (Object.hasOwn(k.vars, code.trim())) {
        reply(msg, 'iopub', 'execute_result', { data: { 'text/plain': k.vars[code.trim()] }, metadata: {}, execution_count: n });
        finish('ok', n);
      } else {
        out(`colab ran: ${code}\n`);
        if (code.trim() === 'answer') reply(msg, 'iopub', 'execute_result', { data: { 'text/plain': '42' }, metadata: {}, execution_count: n });
        finish('ok', n);
      }
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(S(obj)); };
  if (url.pathname === '/token') {
    const form = new URLSearchParams(body);
    if (form.get('refresh_token') !== 'test-refresh-token') return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'test-access-token', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/colaboratory', id_token: idToken });
  }
  const rt = /^\/rt\/([a-z0-9-]+)(\/api\/.*)$/.exec(url.pathname);
  if (rt) {
    const r = runtimes.get(rt[1]);
    const token = req.headers['x-colab-runtime-proxy-token'];
    seen.tokens.push(token);
    if (!r || !r.tokens.includes(token)) return json(403, { message: 'no proxy token' });
    if (rt[2] === '/api/kernels' && req.method === 'POST') { seen.kernelStarts++; r.kernel = { count: 0, vars: {}, colabIds: 0 }; return json(201, { id: 'k1', name: 'python3' }); }
    if (rt[2] === '/api/kernels/k1' && req.method === 'GET') return r.kernel ? json(200, { id: 'k1', name: 'python3' }) : json(404, { message: 'no kernel k1' });
    if (rt[2].endsWith('/interrupt')) { seen.interrupts++; return json(204, {}); }
    if (rt[2].endsWith('/restart')) { seen.restarts++; if (r.kernel) r.kernel.vars = {}; return json(200, { id: 'k1' }); }
    if (req.method === 'DELETE') { seen.kernelDeletes++; r.kernel = null; return json(204, {}); }
    return json(404, {});
  }
  if (req.headers.authorization !== 'Bearer test-access-token') return json(401, { error: { message: 'no access token', status: 'UNAUTHENTICATED' } });
  const faulty = (name) => { const f = fault[name]; delete fault[name]; if (f) json(...f); return !!f; };
  if (url.pathname === '/v1beta/subscription') return faulty('subscription') || json(200, { name: 'subscription', tier: 'SUBSCRIPTION_TIER_FREE' });
  if (url.pathname === '/v1beta/runtimespecs') {
    return json(200, { runtimeSpecs: [
      { key: { variant: 'VARIANT_GPU', accelerator: 'T4', shape: 'SHAPE_STANDARD' }, eligible: true },
      { key: { variant: 'VARIANT_GPU', accelerator: 'A100', shape: 'SHAPE_STANDARD' }, eligible: false },
      { key: { variant: 'VARIANT_CPU', accelerator: 'NONE', shape: 'SHAPE_STANDARD' }, eligible: true },
    ] });
  }
  const info = (id) => {
    const r = runtimes.get(id);
    return { name: `runtimes/${id}`, runtimeSpec: r.spec, connectionInfo: { url: `${base}/rt/${id}/`, token: r.tokens[r.tokens.length - 1], expireTime: new Date(Date.now() + 3 * 60000).toISOString() } };
  };
  if (url.pathname === '/v1beta/runtimes' && req.method === 'POST') {
    if (fault.create) return faulty('create');
    const id = url.searchParams.get('runtimeId');
    runtimes.set(id, { spec: JSON.parse(body).runtimeSpec, tokens: [`proxy-${id}-1`], sockets: [] });
    return json(200, { name: `operations/${id}`, done: false });
  }
  if (url.pathname === '/v1beta/runtimes') return json(200, { runtimes: [...runtimes.keys()].map(info) });
  const op = /^\/v1\/operations\/([a-z0-9-]+):wait$/.exec(url.pathname);
  if (op) return json(200, { name: `operations/${op[1]}`, done: true, response: info(op[1]) });
  const one = /^\/v1beta\/runtimes\/([a-z0-9-]+)$/.exec(url.pathname);
  if (one && runtimes.has(one[1])) {
    if (req.method === 'DELETE') { runtimes.delete(one[1]); seen.released.push(one[1]); return json(200, {}); }
    // Each look-up hands out a fresh proxy token; the previous one keeps working until it expires.
    seen.gets++;
    const r = runtimes.get(one[1]);
    r.tokens.push(`proxy-${one[1]}-${r.tokens.length + 1}`);
    return json(200, info(one[1]));
  }
  return json(404, { error: { message: `no ${url.pathname}` } });
});
server.on('upgrade', (req, socket) => {
  const m = /^\/rt\/([a-z0-9-]+)\/api\/kernels\/k1\/channels/.exec(req.url);
  const token = req.headers['x-colab-runtime-proxy-token'];
  seen.wsTokens.push(token);
  if (!m || !runtimes.get(m[1])?.tokens.includes(token) || !runtimes.get(m[1]).kernel) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  runtimes.get(m[1]).sockets.push(socket);
  kernel(wsAccept(req, socket), runtimes.get(m[1]).kernel);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { GOOGLE_APPLICATION_CREDENTIALS: adc, PYIDE_COLAB_API: base, PYIDE_COLAB_TOKEN_URL: `${base}/token`, PYIDE_GCLOUD: gcloud };
const t = await launch({ fixture: 'notebook', port: 9675, name: 'colab', env });
// Rebound to the second IDE after the restart; the helpers below follow.
let { js, until, check, shot, sleep } = t;
const H = 'ide.activeTab().host';
const V = 'ide.activeTab().notebook';
const banner = () => js(`${H}.querySelector('.nb-banner').innerText`);
const kernelText = () => js(`${H}.querySelector('.nb-kernel-text').textContent`);
const menu = (label) => js(`(() => { ${H}.querySelector('.nb-kernel').click(); const row = [...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.textContent.includes(${S(label)}));
  if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
// Clicked once the list is up: #popupList keeps the last list's rows while hidden.
const pickRow = (text) => until(`(() => { const row = document.querySelector('#popupList')?.offsetParent && [...document.querySelectorAll('#popupList .popup-item')].find((r) => r.textContent.includes(${S(text)}));
  if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`, `pick ${text}`, 10000);
const outputs = (i) => js(`${H}.querySelectorAll('.nb-cell')[${i}].querySelector('.nb-outputs').innerText`);
async function runCell(i, code) {
  await js(`${V}.cells()[${i}].model.setValue(${S(code)})`);
  await js(`${V}.runCell(${i})`);
  await until(`!${H}.querySelectorAll('.nb-cell')[${i}].matches('.running, .queued') && ${H}.dataset.kernel === 'idle'`, `cell ${i}`, 30000);
}

const buttons = () => js(`[...${H}.querySelectorAll('.nb-banner button')].map((b) => b.textContent)`);
const press = (label) => js(`([...${H}.querySelectorAll('.nb-banner button')].find((b) => b.textContent === ${S(label)}).click(), true)`);
const hasButton = (label) => `[...${H}.querySelectorAll('.nb-banner button')].some((b) => b.textContent === ${S(label)})`;

try {
  await openFile(t, 'analysis.ipynb');
  await until(`!!${V}`, 'notebook open', 20000);

  check(await menu('Colab Runtime'), 'the kernel label opens a menu with Local Python and Colab Runtime');
  await until(hasButton('Install Google Cloud CLI'), 'install offer', 10000);
  check(!(await buttons()).includes('Sign In with Google') && (await buttons()).includes('Download Page'), `without gcloud the notebook offers to install it (${S(await buttons())})`);

  // The installer is not run here: the terminal tab and the browser record what they were given.
  await js(`(() => { window.__opened = []; ide.terminal.open = (o) => { window.__opened.push(o.command); return null; };
    const invoke = ide.api.invoke; ide.api.invoke = (ch, ...a) => ch === 'shell:openExternal' ? (window.__opened.push(a[0]), Promise.resolve(true)) : invoke(ch, ...a); return true; })()`);
  await press('Install Google Cloud CLI');
  const opened = await js('window.__opened');
  check(S(opened) === S(['winget install --id Google.CloudSDK -e']) || S(opened) === S(['https://cloud.google.com/sdk/docs/install']),
    `Install Google Cloud CLI runs winget in a terminal tab, or opens Google's install page without winget (${S(opened)})`);
  check((await banner()).includes('opens by itself') && !(await buttons()).includes('Install Google Cloud CLI'), 'while it installs the banner says the sign-in follows by itself');

  writeFileSync(gcloud, fakeGcloud);
  await until(hasButton('Open the Sign-in Page'), 'sign-in starts once gcloud is there', 15000)
    .then(() => check(true, 'once gcloud is installed the Google sign-in starts by itself'), async () => check(false, `after installing: ${S(await buttons())}`));
  const args = readFileSync(at('args.txt'), 'utf8');
  check(/auth application-default login --scopes=\S*auth\/colaboratory/.test(args), `Sign In with Google runs gcloud's sign-in with the Colab scope (${args.trim()})`);
  check((await banner()).includes('browser') && (await buttons()).includes('Cancel'), 'while gcloud waits for the browser the banner says so and offers the sign-in page and Cancel');
  await press('Cancel');
  await until(hasButton('Sign In with Google'), 'back to the sign-in offer', 10000)
    .then(() => check(true, 'after Cancel the banner offers Sign In with Google'), async () => check(false, `after Cancel: ${S(await buttons())}`));
  rmSync(at('alive'), { force: true });
  await sleep(3500);
  check(!existsSync(at('alive')) && !existsSync(adc), 'Cancel ends gcloud (it stops waiting) and nothing is signed in');

  await press('Sign In with Google');
  await until(hasButton('Open the Sign-in Page'), 'waiting again', 15000);
  writeFileSync(at('go'), '');
  await until(`document.querySelector('#popupList')?.offsetParent && document.querySelectorAll('#popupList .popup-item').length >= 2`, 'runtime list', 20000);
  const rows = await js(`[...document.querySelectorAll('#popupList .popup-item')].map((r) => r.textContent)`);
  check(rows.some((r) => r.includes('GPU T4')) && rows.some((r) => r.includes('CPU')) && !rows.some((r) => r.includes('A100')) && rows.some((r) => r.includes('Colab free')),
    `once the browser sign-in is done the runtime list opens by itself with what the plan allows (${S(rows)})`);
  const placeholder = await js(`document.querySelector('#popupIn').placeholder`);
  check(placeholder.includes('ada@example.com'), `the list names the signed-in account (${placeholder})`);
  await pickRow('GPU T4');
  await until(`${H}.dataset.kernel === 'idle'`, 'colab kernel ready', 20000);
  check(/^Colab GPU T4 · Python 3\.12\.11: Idle$/.test(await kernelText()), `the kernel runs on the new GPU runtime (${await kernelText()})`);
  check(runtimes.size === 1 && seen.wsTokens.every((x) => /^proxy-pyide-[0-9a-f]+-\d+$/.test(x)), `the runtime's channels use its proxy token (${S(seen.wsTokens)})`);

  await runCell(1, 'print(1)');
  check((await outputs(1)).includes('colab ran: print(1)'), 'a cell runs on the Colab runtime and shows its output');
  await runCell(1, 'answer');
  check((await outputs(1)).includes('42'), 'a value the runtime returns is shown');
  await runCell(1, 'raise ValueError()');
  check((await outputs(1)).includes('ValueError: on colab'), 'an error on the runtime shows its traceback');
  await js(`${V}.cells()[1].model.setValue('name = input()')`);
  await js(`${V}.runCell(1)`);
  await until(`${H}.querySelector('.nb-stdin-input')`, 'stdin prompt', 10000);
  await js(`(() => { const i = ${H}.querySelector('.nb-stdin-input'); i.value = 'Ada'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`${H}.querySelectorAll('.nb-cell')[1].innerText.includes('hi Ada')`, 'stdin answered', 10000)
    .then(() => check(true, 'input() on the runtime asks in the cell and gets the answer'), async () => check(false, `stdin: ${await outputs(1)}`));
  await js(`([...${H}.querySelectorAll('.nb-toolbar .nb-restart')][0].click(), true)`);
  await until(`${H}.dataset.kernel === 'idle'`, 'restarted', 10000);
  check(seen.restarts === 1, 'Restart Kernel restarts the kernel on the runtime');

  // The proxy token runs out in 3 minutes here: within a minute the notebook fetches a new one and uses it.
  const getsBefore = seen.gets;
  await sleep(65000);
  await runCell(1, 'print(2)');
  const r = [...runtimes.values()][0];
  await js(`(${H}.querySelector('.nb-toolbar .nb-interrupt').disabled = false, ${H}.querySelector('.nb-toolbar .nb-interrupt').click(), true)`);
  await sleep(1500);
  check(seen.gets > getsBefore && seen.tokens[seen.tokens.length - 1] === r.tokens[r.tokens.length - 1],
    `the runtime's proxy token is renewed before it expires and the next request uses it (${seen.gets - getsBefore} renewals, last ${seen.tokens[seen.tokens.length - 1]})`);
  await shot('colab-notebook.png');

  check(await menu('Release the Colab Runtime'), 'the menu offers to release the runtime');
  await until(`${H}.dataset.kernel === 'none'`, 'back to local', 10000);
  await sleep(500);
  check(seen.released.length === 1 && runtimes.size === 0, `Release gives the runtime back to Colab (${S(seen.released)})`);
  check(!/Colab/.test(await kernelText()), 'the notebook is on local Python again');

  fault.subscription = [403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }];
  await menu('Colab Runtime');
  await until(hasButton('Try Again'), 'refused banner', 10000);
  check((await banner()).includes('Google refused Colab access for this account') && !(await buttons()).includes('Sign In with Google'),
    `when Google refuses the account the notebook says so and offers Try Again, not another sign-in (${(await banner()).slice(0, 120)})`);
  await press('Try Again');
  await until(`document.querySelector('#popupList')?.offsetParent && document.querySelectorAll('#popupList .popup-item').length >= 2`, 'list after retry', 10000);
  check(true, 'Try Again gets to the runtime list once Google answers');

  fault.create = [429, { error: { code: 429, message: 'Quota exceeded for GPU', status: 'RESOURCE_EXHAUSTED' } }];
  await pickRow('GPU T4');
  await until(hasButton('Choose Another Runtime'), 'usage limit banner', 10000);
  check((await banner()).includes('usage limits') && (await banner()).includes('Quota exceeded for GPU'), 'a runtime Colab cannot give (usage limits) is explained, with Google\'s message below');
  await press('Choose Another Runtime');
  await pickRow('GPU T4');
  await until(`${H}.dataset.kernel === 'idle'`, 'gpu runtime again', 20000);
  // Colab takes the runtime back: it is gone from the API and its proxy refuses the kernel's socket.
  const [reclaimed] = [...runtimes.keys()];
  for (const sock of runtimes.get(reclaimed).sockets) sock.destroy();
  runtimes.delete(reclaimed);
  await until(hasButton('New Colab Runtime…'), 'runtime gone banner', 30000)
    .then(() => check(true, 'a runtime Colab took back is reported as such, with New Colab Runtime…'), async () => check(false, `reclaimed: ${await banner()}`));
  check(!/Colab/.test(await kernelText()) && !seen.released.includes(reclaimed), `after that the notebook is on local Python and nothing is released twice (${await kernelText()})`);

  writeFileSync(adc, S({ type: 'authorized_user', client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-secret', refresh_token: 'revoked-token' }));
  await press('New Colab Runtime…');
  await until(hasButton('Sign In with Google'), 'expired sign-in banner', 10000);
  check((await banner()).includes('expired or was revoked'), `a sign-in Google no longer accepts asks to sign in again (${(await banner()).slice(0, 120)})`);
  writeFileSync(adc, readFileSync(at('adc.json')));

  await menu('Colab Runtime');
  await pickRow('CPU');
  await until(`${H}.dataset.kernel === 'idle'`, 'cpu runtime', 20000);
  await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
  await until(`!ide.activeTab()?.notebook`, 'closed', 10000).catch(() => {});
  await sleep(1000);
  check(seen.released.length === 2 && runtimes.size === 0, 'closing the notebook releases the runtime it asked for');

  await openFile(t, 'analysis.ipynb');
  await until(`!!${V}`, 'notebook open again', 20000);
  await menu('Colab Runtime');
  await pickRow('CPU');
  await until(`${H}.dataset.kernel === 'idle'`, 'cpu runtime', 20000);
  const [cpu] = [...runtimes.keys()];

  writeFileSync(path.join(t.project, '.env'), 'HF_TOKEN=hf-secret-1\n');
  await runCell(1, "from google.colab import userdata\nprint(userdata.get('HF_TOKEN'))");
  check((await outputs(1)).includes('NotebookAccessError') && (await buttons()).includes('Allow and Run Again'),
    `userdata.get of a .env key first asks whether the notebook may read it (${(await outputs(1)).slice(0, 80)})`);
  await press('Allow and Run Again');
  await until(`${H}.querySelectorAll('.nb-cell')[1].innerText.includes('secret: hf-secret-1')`, 'secret read', 15000)
    .then(() => check(true, 'once allowed the cell runs again and gets the value from .env'), async () => check(false, `allowed secret: ${await outputs(1)}`));
  await runCell(1, "userdata.get('MISSING_KEY')");
  check((await outputs(1)).includes('SecretNotFoundError') && (await banner()).includes('MISSING_KEY'), 'a key .env does not have is "not found", and the banner says how to add it');
  await runCell(1, "from google.colab import drive\ndrive.mount('/content/drive')");
  check((await outputs(1)).includes('MessageError') && (await outputs(1)).includes('PyIDE cannot do this'), 'drive.mount() ends at once with an error that explains why, instead of waiting');
  check(seen.colabReplies.length === 4 && seen.colabReplies.every((r) => r.type === 'colab_reply'), `every colab_request gets a colab_reply on stdin (${seen.colabReplies.length})`);

  const big = crypto.randomBytes(1200 * 1024);
  writeFileSync(path.join(work, 'big.bin'), big);
  writeFileSync(path.join(work, 'data.csv'), 'a,b\n1,2\n');
  await js(`(() => { const invoke = ide.api.invoke; ide.api.invoke = (ch, ...a) => ch === 'colab:pickFiles' ? Promise.resolve(${S([path.join(work, 'big.bin'), path.join(work, 'data.csv')])}) : invoke(ch, ...a); return true; })()`);
  check(await menu('Upload Files to the Runtime'), 'the kernel menu offers Upload Files to the Runtime on Colab');
  await until(`${H}.querySelector('.nb-banner').innerText.includes('Uploaded to the runtime')`, 'uploaded', 30000);
  check(seen.files['big.bin']?.equals(big) && seen.files['data.csv']?.toString() === 'a,b\n1,2\n' && seen.uploadChunks === 4,
    `uploaded files arrive byte for byte in the runtime's working directory, a large one in pieces (${seen.uploadChunks} pieces; ${await banner()})`);

  check(await menu('Keep the Runtime When the Notebook Closes'), 'the kernel menu offers to keep the runtime');
  await runCell(1, 'x = 5');
  const starts = seen.kernelStarts;
  const deletes = seen.kernelDeletes;
  await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
  await sleep(1500);
  check(runtimes.get(cpu)?.kernel && !seen.released.includes(cpu) && seen.kernelDeletes === deletes, 'closing a notebook that keeps its runtime leaves the runtime and its kernel running');
  const kept = JSON.parse(readFileSync(path.join(t.userData, 'colab.json'), 'utf8')).kept;
  check(Object.values(kept).some((b) => b.name === `runtimes/${cpu}` && b.kernelId === 'k1'), `the kept runtime and kernel are remembered for the notebook (${S(kept)})`);
  await openFile(t, 'analysis.ipynb');
  await until(`!!${V} && /Colab CPU/.test(${H}.querySelector('.nb-kernel-text').textContent)`, 'kept runtime restored', 15000);
  await runCell(1, 'x');
  check((await outputs(1)).includes('5') && seen.kernelStarts === starts, `reopened, the notebook is back on the kept kernel with its variables (${await outputs(1)})`);
  t.close();
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
  t.close();
}

// The IDE restarted, on the same profile and project: the kept runtime and kernel are still the notebook's.
const r2 = await launch({ fixture: 'notebook', port: 9676, name: 'colab-restart', userData: t.userData, projectDir: t.project, env });
({ js, until, check, shot, sleep } = r2);
try {
  const starts = seen.kernelStarts;
  await openFile(r2, 'analysis.ipynb');
  await until(`!!${V} && /Colab CPU/.test(${H}.querySelector('.nb-kernel-text').textContent)`, 'kept runtime after restart', 20000);
  await runCell(1, 'x');
  check((await outputs(1)).includes('5') && seen.kernelStarts === starts, `after an IDE restart the notebook reattaches to the kept kernel, variables intact (${await outputs(1)})`);
  check(await menu('Keep the Runtime When the Notebook Closes'), 'keeping can be turned off again');
  await js('(setTimeout(() => window.close(), 100), true)');
  for (let i = 0; i < 60 && runtimes.size; i++) await sleep(250);
  check(seen.released.length === 3 && runtimes.size === 0, `no longer kept, the runtime is released when the IDE quits (${S(seen.released)})`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
r2.close();
server.close();
rmSync(work, { recursive: true, force: true });
const all = [...t.results, ...r2.results];
const failed = all.filter((r) => !r.ok).length;
const errors = [...t.consoleErrors, ...r2.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
