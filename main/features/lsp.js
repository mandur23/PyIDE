// Pyright language server client: one server per project root, JSON-RPC over stdio with Content-Length framing.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const remote = require('../remote');
const diagnostics = require('../diagnostics');

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
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source', 'source.organizeImports'] } }, isPreferredSupport: true },
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true },
  },
  window: { workDoneProgress: true, showMessage: {} },
  general: { positionEncodings: ['utf-16'] },
};

class Server {
  constructor({ unpackedDir, root, pythonPath, gen, send }) {
    Object.assign(this, { root, pythonPath, gen, send });
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.initialized = false;
    this.dead = false;
    this.log = [];
    this.buf = Buffer.alloc(0);
    this.proc = spawn(process.execPath, [path.join(unpackedDir, 'node_modules', 'pyright', 'langserver.index.js'), '--stdio'], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => this.addLog(d.toString('utf8')));
    this.proc.on('error', (err) => this.onExit(err.message));
    this.proc.stdin.on('error', () => {}); // writes until 'exit' marks the server dead would otherwise throw EPIPE
    this.proc.on('exit', (code) => this.onExit(`exited with code ${code}`));
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
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
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
        break;
      default:
        break;
    }
  }

  settingsFor(section) {
    const analysis = { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly', typeCheckingMode: 'standard' };
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

  request(method, params) {
    if (this.dead) return Promise.reject(new Error('language server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    if (this.initialized) this.write({ method, params });
    else this.queue.push({ method, params });
  }

  async initialize() {
    const uri = pathToFileURL(this.root).href;
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'PyIDE' },
      rootUri: uri,
      rootPath: this.root,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: {},
    });
    this.write({ method: 'initialized', params: {} });
    this.write({ method: 'workspace/didChangeConfiguration', params: { settings: { python: this.settingsFor('python') } } });
    this.initialized = true;
    for (const m of this.queue.splice(0)) this.write(m);
  }

  // Pyright only learns about edits to closed files through didChangeWatchedFiles, so mirror the project folder.
  watch() {
    let batch = new Map();
    let timer = null;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (event, file) => {
        if (!file || WATCH_IGNORED.test(`\\${file}`) || !/\.(py|pyi)$|(^|[\\/])(pyrightconfig\.json|pyproject\.toml)$/i.test(file)) return;
        const full = path.join(this.root, file);
        batch.set(full, fs.existsSync(full) ? (event === 'rename' ? 1 : 2) : 3);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const changes = [...batch].map(([p, type]) => ({ uri: pathToFileURL(p).href, type }));
          batch = new Map();
          if (this.initialized) this.notify('workspace/didChangeWatchedFiles', { changes });
        }, 250);
      });
      this.watcher.on('error', () => {});
    } catch {}
  }

  onExit(reason) {
    if (this.dead) return;
    this.dead = true;
    this.watcher?.close();
    for (const p of this.pending.values()) p.reject(new Error(`language server ${reason}`));
    this.pending.clear();
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
    if (immediate) kill();
    else {
      this.request('shutdown').then(() => this.write({ method: 'exit' })).catch(() => {});
      setTimeout(kill, 500);
    }
    this.onExit('stopped');
  }
}

exports.register = ({ ipcMain, app, send, unpackedDir }) => {
  let server = null;
  let gen = 0;

  const start = async (root, pythonPath) => {
    server?.stop();
    server = null;
    if (!root) return null;
    const s = (server = new Server({ unpackedDir, root, pythonPath, gen: ++gen, send }));
    send('lsp:status', { gen: s.gen, state: 'starting' });
    try {
      await s.ready;
    } catch (err) {
      if (server === s) send('lsp:status', { gen: s.gen, state: 'error', message: err.message });
      return null;
    }
    if (server !== s) return null;
    send('lsp:status', { gen: s.gen, state: 'ready' });
    return s.gen;
  };

  // A remote interpreter's Pyright runs here against a synced copy of its libraries (main/remote/index.js).
  ipcMain.handle('lsp:start', (_e, root, pythonPath) => start(root, remote.isRemoteExecutable(pythonPath) ? remote.pyrightPython(pythonPath) : pythonPath));
  ipcMain.handle('lsp:stop', () => { server?.stop(); server = null; });
  ipcMain.handle('lsp:request', async (_e, method, params) => {
    const s = server;
    if (!s) throw new Error('no language server');
    await s.ready;
    return s.request(method, params);
  });
  ipcMain.handle('lsp:notify', (_e, method, params) => { server?.notify(method, params); });
  ipcMain.handle('lsp:log', () => server?.log.join('') || '');
  app.on('will-quit', () => server?.stop(true));
};
