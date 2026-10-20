// Debugger backend: runs the program under `python -m debugpy --listen` as a normal IDE process (so stdout,
// stderr and stdin flow through ctx.startProcess) and talks DAP to debugpy's adapter over TCP.
// Messages thrown here are English; the renderer (renderer/features/debugger/index.js, MAIN_ERRORS) translates them.
const net = require('net');
const path = require('path');
const remote = require('../remote');
const log = require('../diagnostics').logger('#debugger');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

class DapClient {
  constructor(socket, onEvent) {
    this.socket = socket;
    this.onEvent = onEvent;
    this.seq = 1;
    this.pending = new Map();
    this.waiters = [];
    this.buf = Buffer.alloc(0);
    socket.on('data', (d) => this.receive(d));
    socket.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Debug session closed'));
      this.pending.clear();
      for (const w of this.waiters) w.reject(new Error('Debug session closed'));
      this.waiters = [];
    });
  }

  receive(data) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, headerEnd).toString('ascii'));
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.slice(headerEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else {
        log.warn(`DAP ${msg.command} failed: ${msg.body?.error?.format || msg.message || ''}`);
        p.reject(new Error(msg.body?.error?.format || msg.message || `${msg.command} failed`));
      }
    } else if (msg.type === 'event') {
      this.waiters = this.waiters.filter((w) => (w.event === msg.event ? (w.resolve(msg.body || {}), false) : true));
      this.onEvent(msg.event, msg.body || {});
    }
  }

  request(command, args = {}) {
    const seq = this.seq++;
    const json = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }), 'utf8');
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(new Error('Debug session closed'));
      this.pending.set(seq, { resolve, reject });
      this.socket.write(`Content-Length: ${json.length}\r\n\r\n`);
      this.socket.write(json);
    });
  }

  waitEvent(event) {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(new Error('Debug session closed'));
      this.waiters.push({ event, resolve, reject });
    });
  }
}

async function connectWithRetry(port, isAlive, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { log.info(`connected to the debugpy adapter on port ${port}`); resolve(s); });
        s.once('error', reject);
      });
    } catch (err) {
      if (!isAlive() || Date.now() > end) throw new Error(`Could not connect to debugpy on port ${port}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

exports.register = (ctx) => {
  const { ipcMain, send, startProcess, killProcess, procs, vendorDir } = ctx;
  const sessions = new Map(); // procId -> {dap, socket}

  const closeSession = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.socket.destroy();
  };

  // breakpoints: [{path, lines: [{line, condition?, hitCondition?, logMessage?}]}], DAP SourceBreakpoints passed to debugpy
  // as they are (a logMessage makes a logpoint). Resolves {id} once the program runs with breakpoints set.
  // opts: {params?: string[], env?: object, roots?: string[]} from a run configuration (roots go on PYTHONPATH like Run).
  ipcMain.handle('debug:start', async (_e, interp, file, cwd, breakpoints = [], opts = {}) => {
    // A remote interpreter's debugpy listens in the target; the endpoint says where and how this side reaches it.
    const ep = remote.isRemote(interp) ? await remote.debugEndpoint(interp) : null;
    const port = ep ? ep.port : await freePort();
    const pythonPath = [vendorDir, ...(opts.roots || []), opts.env?.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const env = { ...(opts.env || {}), PYTHONPATH: pythonPath, PYDEVD_DISABLE_FILE_VALIDATION: '1' };
    const pyArgs = ['-X', 'frozen_modules=off', '-m', 'debugpy', '--listen', ep ? ep.listen : `127.0.0.1:${port}`,
      '--wait-for-client', file, ...(opts.params || [])];
    const id = ep ? await remote.startPython(ctx, interp, pyArgs, { cwd, env, forwards: ep.forwards, onExit: ep.release })
      : startProcess(interp.cmd, [...interp.args, ...pyArgs], { cwd, env });

    let socket;
    try {
      await ep?.ready(() => procs.has(id));
      socket = await connectWithRetry(port, () => procs.has(id));
    } catch (err) {
      killProcess(id);
      throw err;
    }
    socket.setNoDelay(true);
    const dap = new DapClient(socket, (event, body) => {
      send('debug:event', { id, event, body });
      if (event === 'terminated' || event === 'exited') setTimeout(() => closeSession(id), 300);
    });
    sessions.set(id, { dap, socket });
    socket.on('close', () => {
      if (sessions.delete(id)) send('debug:event', { id, event: 'closed', body: {} });
    });

    try {
      await configure(dap, breakpoints, ep?.pathMappings);
    } catch (err) {
      // A failed handshake must not leave the debuggee running (or listening) with nobody attached.
      closeSession(id);
      if (procs.has(id)) killProcess(id);
      throw err;
    }
    return { id };
  });

  async function configure(dap, breakpoints, pathMappings = []) {
    await dap.request('initialize', {
      clientID: 'pyide', clientName: 'PyIDE', adapterID: 'debugpy', locale: 'en', linesStartAt1: true, columnsStartAt1: true,
      pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false,
    });
    const initialized = dap.waitEvent('initialized');
    // debugpy answers attach only after configurationDone, so it is awaited last.
    const attached = dap.request('attach', { justMyCode: true, redirectOutput: false, showReturnValue: true, subProcess: false,
      // A Linux debugpy translates this side's backslash paths only when told the client is Windows.
      ...(pathMappings.length ? { pathMappings, clientOS: process.platform === 'win32' ? 'windows' : 'unix' } : {}) });
    attached.catch(() => {});
    await initialized;
    for (const bp of breakpoints) {
      await dap.request('setBreakpoints', { source: { path: bp.path }, breakpoints: bp.lines, sourceModified: false }).catch(() => {});
    }
    await dap.request('setExceptionBreakpoints', { filters: ['uncaught'] }).catch(() => {});
    await dap.request('configurationDone');
    await attached;
  }

  ipcMain.handle('debug:request', (_e, id, command, args) => {
    const s = sessions.get(id);
    if (!s) throw new Error('No debug session');
    return s.dap.request(command, args);
  });

  ipcMain.handle('debug:stop', async (_e, id) => {
    const s = sessions.get(id);
    if (s) {
      await Promise.race([s.dap.request('disconnect', { terminateDebuggee: true }).catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
      closeSession(id);
    }
    if (procs.has(id)) killProcess(id);
  });
};
