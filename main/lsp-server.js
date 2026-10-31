// A language server client: one server process per project root, JSON-RPC over stdio with Content-Length framing.
// What differs between servers (how to start one, its settings, the files it watches, when it is ready) comes from a
// spec; main/features/lsp.js (Pyright) and main/features/java-lsp.js (Eclipse JDT LS) each serve one through `serve`.
//
// spec: {
//   name                  'Pyright': messages ("Pyright exited with code 1", timeouts)
//   processName           for diagnostics.watchProcess
//   spawn(server)         -> {cmd, args, env, cwd, cleanup?(immediate)}
//   initializationOptions
//   settingsFor(section)  answers workspace/configuration
//   settings()            sent once initialized (workspace/didChangeConfiguration) unless initializationOptions has
//                         them, and by configurationChanged()
//   shutdownMs            how long stop() waits for shutdown/exit before killing it (500)
//   exclusiveData         a restart waits until the old process has exited (it holds a data folder)
//   watched               RegExp of project files mirrored through didChangeWatchedFiles
//   watchIgnored          RegExp of folders never mirrored
//   projectWide, filesListed, listingTimeout: requests about the whole project wait for a log line matching
//                         filesListed (or the timeout) before they are sent
//   bindAfterEdits        re-binds each open file after edits (Pyright's background analysis, see bindSoon)
//   noCancel              requests never sent $/cancelRequest
//   onNotification(server, method, params) for server-specific notifications
//   whenReady(server)     -> Promise settled when the server can answer (after initialize), else initialize is enough
// }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const diagnostics = require('./diagnostics');
const textCodec = require('./text-codec');

// A request a server never answers (a hang, a lost response) is cancelled and rejected after this many ms, so the
// feature waiting on it does not wait forever. Project-wide searches get longer on a large project.
const REQUEST_TIMEOUT = 30000;
const LONG_REQUESTS = new Set(['initialize', 'textDocument/references', 'textDocument/rename', 'workspace/symbol',
  'callHierarchy/incomingCalls', 'callHierarchy/outgoingCalls', 'workspace/executeCommand']);
const timeoutFor = (method) => (LONG_REQUESTS.has(method) ? 120000 : REQUEST_TIMEOUT);
const notRunning = () => Object.assign(new Error('language server is not running'), { expected: true });

const WATCH_IGNORED = /[\\/](\.git|__pycache__|node_modules|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.idea)([\\/]|$)/;

const CLIENT_CAPABILITIES = {
  workspace: {
    configuration: true,
    workspaceFolders: true,
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: { dynamicRegistration: true },
    symbol: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        tagSupport: { valueSet: [1] },
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        labelDetailsSupport: true,
      },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      contextSupport: true,
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
    },
    definition: { linkSupport: true },
    declaration: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    callHierarchy: { dynamicRegistration: false },
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source', 'source.organizeImports'] } }, isPreferredSupport: true },
    formatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true },
  },
  window: { workDoneProgress: true, showMessage: {} },
  general: { positionEncodings: ['utf-16'] },
};

class Server {
  constructor({ spec, root, gen, send, channel }) {
    Object.assign(this, { spec, root, gen, send, channel });
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.initialized = false;
    this.dead = false;
    this.log = [];
    this.buf = Buffer.alloc(0);
    this.tickets = new Map(); // the renderer's ticket -> request id, for cancel
    this.waiting = new Map(); // the renderer's ticket -> drop(), for a projectWide request waiting for the file list
    this.filesListed = !spec.projectWide;
    this.openUris = new Set();
    this.bindTimers = new Map(); // uri -> timer of bindSoon
    this.listed = new Promise((resolve) => { this.markListed = () => { this.filesListed = true; clearTimeout(this.listingTimer); resolve(); }; });
    if (!this.filesListed) this.listingTimer = setTimeout(this.markListed, spec.listingTimeout || 20000);
    const { cmd, args, env, cwd, cleanup } = spec.spawn(this);
    this.cleanup = cleanup || (() => {});
    this.proc = spawn(cmd, args, { cwd: cwd || root, env, windowsHide: true });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => this.addLog(d.toString('utf8')));
    // Settles once the process is gone (exited, or never started).
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (err) => { this.procGone = true; this.onExit(err.message); resolve(); });
      this.proc.on('exit', (code) => {
        this.procGone = true;
        this.cleanup(false);
        this.onExit(`exited with code ${code}`);
        resolve();
      });
    });
    this.proc.stdin.on('error', () => {}); // writes until 'exit' marks the server gone would otherwise throw EPIPE
    diagnostics.watchProcess(this.proc, { name: spec.processName });
    this.ready = this.initialize().then(() => spec.whenReady?.(this));
    this.ready.catch(() => {});
    this.watch();
  }

  addLog(text) {
    this.log.push(text);
    if (this.log.length > 300) this.log.shift();
  }

  // Writes go on after stop() (shutdown, exit) until the process is gone.
  write(msg) {
    if (this.procGone) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, headerEnd).toString('ascii'));
      if (!m) { this.buf = this.buf.slice(headerEnd + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.slice(headerEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      if (msg.id === this.shutdownId) { this.write({ method: 'exit' }); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      // A request the server reports as cancelled, or failed while cancelling, is no answer, not an IDE internal error.
      if (msg.error && (msg.error.code === -32800 || /_token.cancel|cancell?ed/i.test(msg.error.message || ''))) p.resolve(null);
      else if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.id !== undefined) {
      Promise.resolve(this.onServerRequest(msg.method, msg.params))
        .then((result) => this.write({ id: msg.id, result: result ?? null }))
        .catch((err) => this.write({ id: msg.id, error: { code: -32603, message: String(err?.message || err) } }));
      return;
    }
    switch (msg.method) {
      case 'textDocument/publishDiagnostics':
        this.send(`${this.channel}:diagnostics`, { gen: this.gen, ...msg.params });
        break;
      case 'window/showMessage':
        this.send(`${this.channel}:message`, { gen: this.gen, ...msg.params });
        break;
      case 'window/logMessage':
        this.addLog(`${msg.params.message}\n`);
        if (!this.filesListed && this.spec.filesListed?.test(msg.params.message || '')) this.markListed();
        break;
      default:
        this.spec.onNotification?.(this, msg.method, msg.params);
        break;
    }
  }

  onServerRequest(method, params) {
    switch (method) {
      case 'workspace/configuration':
        return params.items.map((it) => this.spec.settingsFor(it.section) ?? null);
      case 'workspace/workspaceFolders':
        return [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      case 'workspace/applyEdit':
        // The renderer owns open models, so it applies the edit (including files it must write to disk).
        this.send(`${this.channel}:applyEdit`, { gen: this.gen, edit: params.edit, label: params.label });
        return { applied: true };
      default:
        return null;
    }
  }

  // ticket: a key the renderer can later pass to cancel(ticket).
  request(method, params, ticket) {
    if (this.dead) return Promise.reject(notRunning());
    if (this.filesListed || !this.spec.projectWide.has(method)) return this.call(method, params, ticket);
    return new Promise((resolve, reject) => {
      // Cancelled while waiting for the file list: no answer, and it is never sent.
      let dropped = false;
      if (ticket != null) this.waiting.set(ticket, () => { dropped = true; resolve(null); });
      this.listed.then(() => {
        if (ticket != null) this.waiting.delete(ticket);
        if (dropped) return;
        if (this.dead) return reject(notRunning());
        this.call(method, params, ticket).then(resolve, reject);
      });
    });
  }

  call(method, params, ticket) {
    const id = this.nextId++;
    const ms = timeoutFor(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.cancelId(id);
        if (ticket != null) this.tickets.delete(ticket);
        // Expected on a very large file (a million lines): the renderer treats it as no answer, and it is not an
        // IDE internal error (main/diagnostics).
        reject(Object.assign(new Error(`${this.spec.name} did not answer ${method} within ${ms / 1000} s`), { expected: true }));
      }, ms);
      const settle = (fn) => (v) => { clearTimeout(timer); if (ticket != null) this.tickets.delete(ticket); fn(v); };
      this.pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      if (ticket != null) this.tickets.set(ticket, id);
      this.write({ id, method, params });
    });
  }

  // A cancelled request answers null at once, and the server drops it if it has not started on it yet. (One it is
  // working on runs to the end: Pyright reads $/cancelRequest between requests.)
  cancel(ticket) {
    const drop = this.waiting.get(ticket);
    if (drop) { this.waiting.delete(ticket); drop(); return; }
    const id = this.tickets.get(ticket);
    const p = id !== undefined && this.pending.get(id);
    if (!p) return;
    // Its late answer finds no pending entry and is ignored.
    if (this.spec.noCancel?.has(p.method)) this.pending.delete(id);
    else this.cancelId(id);
    p.resolve(null);
  }

  cancelId(id) {
    this.pending.delete(id);
    this.write({ method: '$/cancelRequest', params: { id } });
  }

  notify(method, params) {
    if (this.initialized) this.write({ method, params });
    else this.queue.push({ method, params });
    const uri = params?.textDocument?.uri;
    if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
      this.openUris.add(uri);
      this.bindSoon([uri]);
    } else if (method === 'textDocument/didClose') {
      this.openUris.delete(uri);
    }
  }

  // With checking on its background thread, Pyright's thread that answers requests binds a file (collects its names)
  // only when a request needs it, and completion offers auto-imports only from files bound there: a function added to
  // an open shapes.py was missing from completion in main.py, and Pyright unbinds every file when one is added to the
  // project. So each open file is bound again BIND_PAUSE ms after its last edit or the project's last file change, by
  // a request that needs nothing else (a hover at its start).
  bindSoon(uris) {
    if (!this.spec.bindAfterEdits) return;
    for (const uri of uris) {
      clearTimeout(this.bindTimers.get(uri));
      this.bindTimers.set(uri, setTimeout(() => {
        this.bindTimers.delete(uri);
        if (!this.openUris.has(uri)) return;
        this.ready.then(() => this.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } })).catch(() => {});
      }, 1000));
    }
  }

  async initialize() {
    const uri = pathToFileURL(this.root).href;
    const init = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Nano Studio' },
      rootUri: uri,
      rootPath: this.root,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions || {},
    });
    // TextDocumentSyncKind.Incremental (2): the renderer sends edits instead of the whole text on every change.
    const sync = init?.capabilities?.textDocumentSync;
    this.incremental = (typeof sync === 'number' ? sync : sync?.change) === 2;
    this.write({ method: 'initialized', params: {} });
    // A server given its settings with initialize (JDT LS) gets them again only when they change.
    if (!this.spec.initializationOptions?.settings) this.configurationChanged();
    this.initialized = true;
    for (const m of this.queue.splice(0)) this.write(m);
  }

  configurationChanged() {
    const settings = this.spec.settings?.();
    if (settings) this.write({ method: 'workspace/didChangeConfiguration', params: { settings } });
  }

  // A server only learns about edits to closed files through didChangeWatchedFiles, so mirror the project folder.
  // A checkout changes thousands of files, so the callback only collects names (a file added or removed shows as a
  // 'rename' event); a batch goes once nothing has arrived for 250 ms, after checking which of its files still exist
  // off the main thread. (An existsSync per event kept the main process, and every window's IPC, busy for most of a
  // second when 10,000 files changed.)
  watch() {
    let batch = new Map(); // full path -> renamed (added or removed) at some point in the batch
    let timer = null;
    let last = 0;
    const flush = async () => {
      const quiet = Date.now() - last;
      if (quiet < 250) { timer = setTimeout(flush, 250 - quiet); return; }
      timer = null;
      const events = batch;
      batch = new Map();
      const changes = await Promise.all([...events].map(async ([full, renamed]) => {
        const exists = await fs.promises.access(full).then(() => true, () => false);
        // A save that replaced the file by rename is a change, not a new file.
        return { uri: pathToFileURL(full).href, type: exists ? (renamed && !textCodec.replacedRecently(full) ? 1 : 2) : 3 };
      }));
      if (!this.initialized || this.dead) return;
      this.notify('workspace/didChangeWatchedFiles', { changes });
      this.bindSoon(this.openUris);
    };
    const ignored = this.spec.watchIgnored;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (event, file) => {
        if (!file || WATCH_IGNORED.test(`\\${file}`) || ignored?.test(`\\${file}`) || !this.spec.watched.test(file)) return;
        const full = path.join(this.root, file);
        batch.set(full, batch.get(full) || event === 'rename');
        last = Date.now();
        if (!timer) timer = setTimeout(flush, 250);
      });
      this.watcher.on('error', () => {});
    } catch {}
  }

  onExit(reason) {
    if (this.dead) return;
    this.dead = true;
    this.watcher?.close();
    for (const timer of this.bindTimers.values()) clearTimeout(timer);
    // Requests in flight when the server stops (another project, another interpreter) or exits get no answer; the
    // renderer treats that as none, and the exit itself is reported, so these are not internal errors as well.
    for (const p of this.pending.values()) p.reject(Object.assign(new Error(`language server ${reason}`), { expected: true }));
    this.pending.clear();
    this.tickets.clear();
    this.markListed(); // requests waiting for the file list get "not running"
    if (!this.stopping) {
      this.addLog(`server ${reason}\n`);
      this.send(`${this.channel}:status`, { gen: this.gen, state: 'error', message: `${this.spec.name} ${reason}` });
    }
  }

  // shutdown, then exit once the server answers it (it may save its state meanwhile); killed after shutdownMs. ->
  // the exited promise.
  stop(immediate) {
    this.stopping = true;
    this.watcher?.close();
    if (this.procGone) return this.exited;
    const kill = () => { try { this.proc.kill(); } catch {} };
    if (immediate) {
      kill();
      this.cleanup(true);
    } else {
      this.shutdownId = this.nextId++;
      this.write({ id: this.shutdownId, method: 'shutdown' });
      setTimeout(kill, this.spec.shutdownMs || 500);
    }
    this.onExit('stopped');
    return this.exited;
  }
}

// Serves one language server under IPC channels prefixed `channel` (the feature's name):
//   <channel>:start(root, ...args) -> {gen, incremental} | {error, code} | null (null: it stopped or another start
//   replaced it). makeSpec(root, ...args) -> spec; an error it throws (not installed, untrusted) is the answer.
//   <channel>:stop, <channel>:request(method, params, ticket?), <channel>:cancel(ticket), <channel>:notify(method,
//   params), <channel>:log
// and sends <channel>:status {gen, state: starting|ready|error, message?}, <channel>:diagnostics, <channel>:message,
// <channel>:applyEdit. -> {current()}: the running server, if any.
function serve({ ipcMain, app, send }, channel, makeSpec) {
  let server = null;
  let gen = 0;

  const start = async (root, args) => {
    const old = server;
    old?.stop();
    server = null;
    const my = ++gen;
    // A server that keeps its state in a folder of its own (JDT LS's workspace) must be gone before the next one
    // opens that folder.
    if (old?.spec.exclusiveData) await old.exited;
    if (gen !== my || !root) return null;
    let spec;
    try {
      spec = await makeSpec(root, ...args);
    } catch (err) {
      return gen === my ? { error: err.message, code: err.code } : null;
    }
    if (gen !== my) return null;
    const s = (server = new Server({ spec, root, gen: my, send, channel }));
    send(`${channel}:status`, { gen: my, state: 'starting' });
    try {
      await s.ready;
    } catch (err) {
      if (server === s) send(`${channel}:status`, { gen: s.gen, state: 'error', message: err.message });
      return null;
    }
    if (server !== s) return null;
    send(`${channel}:status`, { gen: s.gen, state: 'ready' });
    return { gen: s.gen, incremental: s.incremental };
  };

  ipcMain.handle(`${channel}:start`, (_e, root, ...args) => start(root, args));
  ipcMain.handle(`${channel}:stop`, () => { gen++; server?.stop(); server = null; });
  // ticket (optional): a key for <channel>:cancel, which answers the request with null and tells the server to drop it.
  ipcMain.handle(`${channel}:request`, async (_e, method, params, ticket) => {
    const s = server;
    if (!s) throw new Error('no language server');
    await s.ready;
    return s.request(method, params, ticket);
  });
  ipcMain.handle(`${channel}:cancel`, (_e, ticket) => { server?.cancel(ticket); });
  ipcMain.handle(`${channel}:notify`, (_e, method, params) => { server?.notify(method, params); });
  ipcMain.handle(`${channel}:log`, () => server?.log.join('') || '');
  app.on('will-quit', () => server?.stop(true));
  return { current: () => server };
}

module.exports = { Server, serve };
