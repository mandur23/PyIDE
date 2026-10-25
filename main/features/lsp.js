// Pyright language server client: one server per project root, JSON-RPC over stdio with Content-Length framing.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const remote = require('../remote');
const diagnostics = require('../diagnostics');
const textCodec = require('../text-codec');
const projectRoots = require('../project-roots');

// Pyright's search paths and exclusions from the project's roots (Mark Directory As): the source roots replace its own
// guess (autoSearchPaths adds src/), so the editor resolves imports as Run does, and excluded folders leave its file
// list. Its default exclusions apply only while `exclude` is unset, so they are repeated.
function rootSettings(root) {
  const excluded = projectRoots.excludedDirs(root);
  return {
    autoSearchPaths: false,
    extraPaths: projectRoots.pythonPaths(root),
    ...(excluded.length ? { exclude: ['**/node_modules', '**/__pycache__', '**/.*', ...excluded] } : {}),
  };
}

// A request Pyright never answers (a hang, a lost response) is cancelled and rejected after this many ms, so the
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
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true },
  },
  window: { workDoneProgress: true, showMessage: {} },
  general: { positionEncodings: ['utf-16'] },
};

// Requests never sent $/cancelRequest (see Server.cancel).
const NO_CANCEL = new Set(['textDocument/references']);

// Requests about the whole project. Pyright lists the project's source files after it has started (the initialize
// answer comes first) and logs "Found N source files" when it has; asked before that, it answers from the open files
// only: Type Hierarchy right after opening a project showed no subtypes in closed files (seen on the CI runner, whose
// small screen made the suite press Ctrl+H a little sooner), and Find Usages or a rename would miss them too. These
// wait for the list, or for LISTING_TIMEOUT after the server started if the log never comes.
const PROJECT_WIDE = new Set(['textDocument/references', 'textDocument/rename', 'workspace/symbol', 'callHierarchy/incomingCalls']);
const FILES_LISTED = /^(Found \d+ source files?|No source files found)/;
const LISTING_TIMEOUT = 20000;

// Pyright checks an open file after each edit (a 20,000-line file: about 5 s). Without its background-analysis thread
// it checks on the thread that answers requests, and a completion asked meanwhile waited for the whole check. The
// thread runs when Pyright gets --cancellationReceive, but the bundled Pyright starts it from the bundle chunk that
// holds its code, which only defines modules, so the thread did nothing and no diagnostics came. BOOT runs Pyright with
// worker_threads.Worker started from the language server entry instead (argv[1]), where a worker runs the analysis.
const BOOT = "const wt=require('worker_threads');const entry=process.argv[1];if(wt.isMainThread){const W=wt.Worker;"
  + 'wt.Worker=class extends W{constructor(_file,options){super(entry,options)}}}require(entry)';
// Pyright reads cancellations, and its two threads exchange them, as files in this folder under the temp folder.
const cancellationDir = (name) => path.join(os.tmpdir(), 'python-languageserver-cancellation', name);

// With checking on the background thread, the thread that answers requests binds a file (collects its names) only
// when a request needs it, and completion offers auto-imports only from files bound there: a function added to an
// open shapes.py was missing from completion in main.py, and Pyright unbinds every file when one is added to the
// project. The check of the open files used to bind them. Now each open file is bound again BIND_PAUSE ms after its
// last edit or the project's last file change, by a request that needs nothing else (a hover at its start).
const BIND_PAUSE = 1000;

// Folders left by IDE processes that ended without stopping Pyright (killed, crashed): named pyide-<pid>-<gen>.
function removeStaleCancellationDirs() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
  fs.readdir(cancellationDir(''), (_err, names) => {
    for (const name of names || []) {
      const pid = Number(/^pyide-(\d+)-\d+$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) fs.rm(cancellationDir(name), { recursive: true, force: true }, () => {});
    }
  });
}

class Server {
  constructor({ unpackedDir, root, pythonPath, locale, gen, send }) {
    Object.assign(this, { root, pythonPath, gen, send });
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.initialized = false;
    this.dead = false;
    this.log = [];
    this.buf = Buffer.alloc(0);
    this.tickets = new Map(); // the renderer's ticket -> request id, for lsp:cancel
    this.waiting = new Map(); // the renderer's ticket -> drop(), for a PROJECT_WIDE request waiting for the file list
    this.filesListed = false;
    this.openUris = new Set();
    this.bindTimers = new Map(); // uri -> timer of bindSoon
    this.listed = new Promise((resolve) => { this.markListed = () => { this.filesListed = true; clearTimeout(this.listingTimer); resolve(); }; });
    this.listingTimer = setTimeout(this.markListed, LISTING_TIMEOUT);
    const cancellation = `pyide-${process.pid}-${gen}`;
    this.cancellationDir = cancellationDir(cancellation);
    try { fs.mkdirSync(this.cancellationDir, { recursive: true }); } catch {}
    const entry = path.join(unpackedDir, 'node_modules', 'pyright', 'langserver.index.js');
    this.proc = spawn(process.execPath, ['-e', BOOT, entry, '--stdio', `--cancellationReceive=file:${cancellation}`], {
      cwd: root,
      // Pyright writes its diagnostics and hovers in the locale VSCODE_NLS_CONFIG names (the IDE's language); without it
      // it falls back to LC_ALL/LANG, which Windows does not set.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_NLS_CONFIG: JSON.stringify({ locale }) },
      windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => this.addLog(d.toString('utf8')));
    this.proc.on('error', (err) => this.onExit(err.message));
    this.proc.stdin.on('error', () => {}); // writes until 'exit' marks the server dead would otherwise throw EPIPE
    this.proc.on('exit', (code) => {
      fs.rm(this.cancellationDir, { recursive: true, force: true }, () => {});
      this.onExit(`exited with code ${code}`);
    });
    diagnostics.watchProcess(this.proc, { name: 'Pyright language server' });
    this.ready = this.initialize();
    this.ready.catch(() => {});
    this.watch();
  }

  addLog(text) {
    this.log.push(text);
    if (this.log.length > 300) this.log.shift();
  }

  write(msg) {
    if (this.dead) return;
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
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      // A request Pyright reports as cancelled, or failed while cancelling, is no answer, not an IDE internal error.
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
        this.send('lsp:diagnostics', { gen: this.gen, ...msg.params });
        break;
      case 'window/showMessage':
        this.send('lsp:message', { gen: this.gen, ...msg.params });
        break;
      case 'window/logMessage':
        this.addLog(`${msg.params.message}\n`);
        if (!this.filesListed && FILES_LISTED.test(msg.params.message || '')) this.markListed();
        break;
      default:
        break;
    }
  }

  settingsFor(section) {
    const analysis = { useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly', typeCheckingMode: 'standard', ...rootSettings(this.root) };
    if (section === 'python') return { pythonPath: this.pythonPath, analysis };
    if (section === 'python.analysis') return analysis;
    if (section === 'python.pythonPath') return this.pythonPath;
    if (section === 'pyright') return {};
    return null;
  }

  onServerRequest(method, params) {
    switch (method) {
      case 'workspace/configuration':
        return params.items.map((it) => this.settingsFor(it.section));
      case 'workspace/workspaceFolders':
        return [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      case 'workspace/applyEdit':
        // The renderer owns open models, so it applies the edit (including files it must write to disk).
        this.send('lsp:applyEdit', { gen: this.gen, edit: params.edit, label: params.label });
        return { applied: true };
      default:
        return null;
    }
  }

  // ticket: a key the renderer can later pass to cancel(ticket).
  request(method, params, ticket) {
    if (this.dead) return Promise.reject(notRunning());
    if (this.filesListed || !PROJECT_WIDE.has(method)) return this.call(method, params, ticket);
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
        reject(Object.assign(new Error(`Pyright did not answer ${method} within ${ms / 1000} s`), { expected: true }));
      }, ms);
      const settle = (fn) => (v) => { clearTimeout(timer); if (ticket != null) this.tickets.delete(ticket); fn(v); };
      this.pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      if (ticket != null) this.tickets.set(ticket, id);
      this.write({ id, method, params });
    });
  }

  // A cancelled request answers null at once, and Pyright drops it if it has not started on it yet. (One it is working
  // on runs to the end: Pyright reads $/cancelRequest between requests.)
  cancel(ticket) {
    const drop = this.waiting.get(ticket);
    if (drop) { this.waiting.delete(ticket); drop(); return; }
    const id = this.tickets.get(ticket);
    const p = id !== undefined && this.pending.get(id);
    if (!p) return;
    // Pyright 1.1.406 fails a references request it is told to cancel ("this._token.cancel is not a function", seen
    // on the CI runner), so that one is only dropped here; its late answer finds no pending entry and is ignored.
    if (NO_CANCEL.has(p.method)) this.pending.delete(id);
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

  bindSoon(uris) {
    for (const uri of uris) {
      clearTimeout(this.bindTimers.get(uri));
      this.bindTimers.set(uri, setTimeout(() => {
        this.bindTimers.delete(uri);
        if (!this.openUris.has(uri)) return;
        this.ready.then(() => this.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } })).catch(() => {});
      }, BIND_PAUSE));
    }
  }

  async initialize() {
    const uri = pathToFileURL(this.root).href;
    const init = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'PyIDE' },
      rootUri: uri,
      rootPath: this.root,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: {},
    });
    // TextDocumentSyncKind.Incremental (2): the renderer sends edits instead of the whole text on every change.
    const sync = init?.capabilities?.textDocumentSync;
    this.incremental = (typeof sync === 'number' ? sync : sync?.change) === 2;
    this.write({ method: 'initialized', params: {} });
    this.write({ method: 'workspace/didChangeConfiguration', params: { settings: { python: this.settingsFor('python') } } });
    this.initialized = true;
    for (const m of this.queue.splice(0)) this.write(m);
  }

  // Pyright only learns about edits to closed files through didChangeWatchedFiles, so mirror the project folder.
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
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (event, file) => {
        if (!file || WATCH_IGNORED.test(`\\${file}`) || !/\.(py|pyi)$|(^|[\\/])(pyrightconfig\.json|pyproject\.toml)$/i.test(file)) return;
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
      this.send('lsp:status', { gen: this.gen, state: 'error', message: `Pyright ${reason}` });
    }
  }

  stop(immediate) {
    this.stopping = true;
    this.watcher?.close();
    if (this.dead) return;
    const kill = () => { try { this.proc.kill(); } catch {} };
    if (immediate) {
      kill();
      try { fs.rmSync(this.cancellationDir, { recursive: true, force: true }); } catch {}
    } else {
      this.request('shutdown').then(() => this.write({ method: 'exit' })).catch(() => {});
      setTimeout(kill, 500);
    }
    this.onExit('stopped');
  }
}

exports.register = ({ ipcMain, app, send, unpackedDir }) => {
  removeStaleCancellationDirs();
  let server = null;
  let gen = 0;
  // New roots reach a running server as new settings, which Pyright reads back through workspace/configuration.
  projectRoots.onChange((root) => {
    const s = server;
    if (!s?.initialized || s.dead || path.resolve(root).toLowerCase() !== path.resolve(s.root).toLowerCase()) return;
    s.write({ method: 'workspace/didChangeConfiguration', params: { settings: { python: s.settingsFor('python') } } });
  });

  const start = async (root, pythonPath, locale) => {
    server?.stop();
    server = null;
    if (!root) return null;
    const s = (server = new Server({ unpackedDir, root, pythonPath, locale, gen: ++gen, send }));
    send('lsp:status', { gen: s.gen, state: 'starting' });
    try {
      await s.ready;
    } catch (err) {
      if (server === s) send('lsp:status', { gen: s.gen, state: 'error', message: err.message });
      return null;
    }
    if (server !== s) return null;
    send('lsp:status', { gen: s.gen, state: 'ready' });
    return { gen: s.gen, incremental: s.incremental };
  };

  // A remote interpreter's Pyright runs here against a synced copy of its libraries (main/remote/index.js).
  // -> {gen, incremental} | null
  // locale: the UI language ('en', 'ko'), for Pyright's messages.
  ipcMain.handle('lsp:start', (_e, root, pythonPath, locale = 'en') => start(root, remote.isRemoteExecutable(pythonPath) ? remote.pyrightPython(pythonPath) : pythonPath,
    /^[a-z]{2}(-[a-z]{2,4})?$/i.test(locale) ? locale.toLowerCase() : 'en'));
  ipcMain.handle('lsp:stop', () => { server?.stop(); server = null; });
  // ticket (optional): a key for lsp:cancel, which answers the request with null and tells Pyright to drop it.
  ipcMain.handle('lsp:request', async (_e, method, params, ticket) => {
    const s = server;
    if (!s) throw new Error('no language server');
    await s.ready;
    return s.request(method, params, ticket);
  });
  ipcMain.handle('lsp:cancel', (_e, ticket) => { server?.cancel(ticket); });
  ipcMain.handle('lsp:notify', (_e, method, params) => { server?.notify(method, params); });
  ipcMain.handle('lsp:log', () => server?.log.join('') || '');
  app.on('will-quit', () => server?.stop(true));
};
