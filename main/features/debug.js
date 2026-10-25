// Debugger backend: runs the program under `python -m debugpy --listen` as a normal IDE process (so stdout,
// stderr and stdin flow through ctx.startProcess) and talks DAP to debugpy's adapter over TCP.
// Messages thrown here are English; the renderer (renderer/features/debugger/index.js, MAIN_ERRORS) translates them.
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const remote = require('../remote');
const attachTo = require('./debug-attach');
const { withEnvFiles } = require('../dotenv');
const { workingDir } = require('./run');
const log = require('../diagnostics').logger('#debugger');

const { stoppedError } = attachTo;

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

const HANDSHAKE_TIMEOUT_MS = 30000;

const connectOnce = (port) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { log.info(`connected to the debugpy adapter on port ${port}`); resolve(s); });
  s.once('error', reject);
});

// giveUp(err) -> Error: what to throw once the target is gone or the time is up (attach words it its own way).
async function connectWithRetry(port, isAlive, timeoutMs = 20000, giveUp = null) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connectOnce(port);
    } catch (err) {
      if (!isAlive() || Date.now() > end) throw giveUp?.(err) || new Error(`Could not connect to debugpy on port ${port}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// The long form of a path that names folders by their 8.3 short names (C:\Users\RUNNER~1\…), the form debugpy
// reports frames in (GetLongPathName): each short name becomes the long one, and links are not followed.
function longPath(p) {
  if (process.platform !== 'win32' || !p.includes('~')) return p;
  const parent = path.dirname(p);
  if (parent === p) return p;
  let name = path.basename(p);
  if (name.includes('~')) {
    try { if (!fs.lstatSync(p).isSymbolicLink()) name = path.basename(fs.realpathSync.native(p)); } catch {}
  }
  return path.join(longPath(parent), name);
}

// `python -m debugpy` and debugpy's own `-m` put the working folder first on sys.path (as its absolute path and as
// ''), so in an 8.3 working folder the modules a run imports from it get 8.3 file names, which pydevd cannot resolve
// once their long form exceeds MAX_PATH ("unable to get real case"). This launcher, given the folder's long form,
// makes that sys.path entry import through a finder rooted at the long form (when Python can read it there) and then
// runs debugpy as `-m debugpy` does.
const LONG_CWD_DEBUGPY = [
  'import os, sys',
  '_long = sys.argv.pop(1)',
  'if os.path.isdir(_long):',
  '    for _hook in sys.path_hooks:',
  '        try:',
  '            sys.path_importer_cache[os.getcwd()] = _hook(_long)',
  '            break',
  '        except ImportError:',
  '            pass',
  'from debugpy.server import cli',
  'cli.main()',
].join('\n');

exports.register = (ctx) => {
  const { ipcMain, send, startProcess, killProcess, procs, vendorDir } = ctx;
  const sessions = new Map(); // procId -> {dap, socket}
  const starting = new Map(); // opts.startKey of a debug:start in progress -> its stop()

  const closeSession = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.socket.destroy();
  };

  // breakpoints: [{path, lines: [{line, condition?, hitCondition?, logMessage?}]}], DAP SourceBreakpoints passed to debugpy
  // as they are (a logMessage makes a logpoint). Resolves {id} once the program runs with breakpoints set.
  // opts: {params?: string[], env?: object, roots?: string[]} from a run configuration (roots go on PYTHONPATH like Run).
  // opts.startKey: names this startup for debug:stop(null, startKey), which ends it before the renderer has its id.
  // opts.exceptions: the DAP setExceptionBreakpoints arguments (default: suspend on uncaught exceptions).
  ipcMain.handle('debug:start', async (_e, interp, file, cwd, breakpoints = [], opts = {}) => {
    let stopped = false;
    let fail;
    const failed = new Promise((_r, reject) => { fail = reject; });
    failed.catch(() => {});
    const key = opts.startKey;
    if (key != null) starting.set(key, () => { stopped = true; fail(stoppedError()); });
    let id = null;
    let timer;
    try {
      // A remote interpreter's debugpy listens in the target; the endpoint says where and how this side reaches it.
      const ep = remote.isRemote(interp) ? await remote.debugEndpoint(interp) : null;
      const port = ep ? ep.port : await freePort();
      if (stopped) { ep?.release(); throw stoppedError(); }
      // opts.envFiles: .env files under opts.env (undefined: the project root's .env), as for run:start.
      const userEnv = withEnvFiles(opts.env, opts.envFiles, opts.roots?.[0]);
      const pythonPath = [vendorDir, ...(opts.roots || []), userEnv.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      const env = { ...userEnv, PYTHONPATH: pythonPath, PYDEVD_DISABLE_FILE_VALIDATION: '1' };
      // A local script goes by its long form: pydevd resolves an 8.3 short name only while the long form fits MAX_PATH,
      // and past that prints "unable to get real case" tracebacks into the output. Breakpoints are sent in the same form.
      const wd = ep ? cwd : (await workingDir(cwd, opts.roots)).cwd;
      const longWd = !ep && wd ? longPath(path.resolve(wd)) : null;
      const launcher = longWd && longWd !== path.resolve(wd) ? ['-c', LONG_CWD_DEBUGPY, longWd] : ['-m', 'debugpy'];
      const pyArgs = ['-X', 'frozen_modules=off', ...launcher, '--listen', ep ? ep.listen : `127.0.0.1:${port}`,
        '--wait-for-client', ep ? file : longPath(file), ...(opts.params || [])];
      id = ep ? await remote.startPython(ctx, interp, pyArgs, { cwd, env, forwards: ep.forwards, onExit: ep.release })
        : startProcess(interp.cmd, [...interp.args, ...pyArgs], { cwd: wd, env });
      // The renderer shows the debuggee's output from now on, so a program that ends before debugpy listens (a Python
      // debugpy cannot run on, an import error) shows why, and its output is not left buffered for nobody.
      if (key != null) send('debug:event', { id: null, startKey: key, event: 'process', body: { id } });
      if (stopped) throw stoppedError();

      const alive = () => procs.has(id) && !stopped;
      const connecting = (async () => {
        await ep?.ready(alive);
        return connectWithRetry(port, alive, undefined, () => (stopped ? stoppedError()
          : !procs.has(id) ? Object.assign(new Error('The program exited before the debugger could connect'), { expected: true }) : null));
      })();
      // A socket that connects after a stop has nobody to talk to.
      connecting.then((sock) => { if (stopped) sock.destroy(); }, () => {});
      const socket = await Promise.race([connecting, failed]);
      socket.setNoDelay(true);
      const dap = new DapClient(socket, (event, body) => {
        send('debug:event', { id, event, body });
        if (event === 'terminated' || event === 'exited') setTimeout(() => closeSession(id), 300);
      });
      sessions.set(id, { dap, socket, remote: !!ep });
      socket.on('close', () => {
        if (sessions.delete(id)) send('debug:event', { id, event: 'closed', body: {} });
      });
      // A debugpy that accepts the connection but never answers or never sends 'initialized' would otherwise keep this
      // startup (and the Stop button) waiting forever.
      timer = setTimeout(() => fail(new Error(`debugpy did not start the debug session within ${HANDSHAKE_TIMEOUT_MS / 1000} seconds`)),
        HANDSHAKE_TIMEOUT_MS);
      // pydevd resolves its auto-reload folders even with auto-reload off, by default the working folder, which may be
      // an 8.3 one (run.js workingDir) it cannot resolve either; the script's folder stands in, or for `-m` (a module, the
      // test runner) the working folder's long form.
      const watched = file === '-m' ? longWd || path.resolve(wd || '') : path.dirname(longPath(file));
      const local = ep ? {} : { autoReload: { enable: false, watchDirectories: [watched] } };
      await Promise.race([configure(dap, breakpoints, opts.exceptions, ep?.pathMappings, local), failed]);
      return { id };
    } catch (err) {
      // A failed or stopped startup must not leave the debuggee running (or listening) with nobody attached.
      if (id != null) {
        closeSession(id);
        killProcess(id);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (key != null) starting.delete(key);
    }
  });

  // ---------- Attach to Process ----------
  const ownDirs = attachTo.ownDirsFor({ appDir: ctx.appDir, unpackedDir: ctx.unpackedDir, vendorDir,
    userData: ctx.app?.getPath('userData'), home: os.homedir() });
  ipcMain.handle('debug:processes', () => attachTo.listProcesses({ ownDirs }));

  const ATTACH_TIMEOUT_MS = Number(process.env.PYIDE_ATTACH_TIMEOUT_MS) || 20000;
  // pid -> {port, created}: where the debugpy injected into that process listens (it can listen only once per process).
  // created, the process start time, tells that process from a later one that reuses its pid.
  const listening = new Map();
  const forget = (pid) => { if (!attachTo.pidState(pid)) listening.delete(pid); };
  const aborts = new Set(); // abort() of every debug:attach in progress
  let attachSeq = 0;
  // Quitting mid-attach: no injector may outlive PyIDE (it would leave the target's debugpy listening for nobody).
  ctx.app?.on('will-quit', () => {
    attachTo.killInjectors();
    for (const abort of [...aborts]) abort();
  });

  // target: {pid, created?} of an entry of debug:processes. The process is looked up again here: its interpreter and
  // debugpy port come from that listing, never from the renderer, and a pid that now names a process started at another
  // time (the listed one exited and its pid was reused) is refused. Resolves {id, pid, version} once the session runs;
  // the target keeps running when it ends (debug:stop detaches).
  ipcMain.handle('debug:attach', async (_e, target, breakpoints = [], opts = {}) => {
    const pid = Number(target?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('No process selected');
    let stopped = false;
    let fail;
    const failed = new Promise((_r, reject) => { fail = reject; });
    failed.catch(() => {});
    let injector = null;
    const abort = (kill = true) => {
      if (stopped) return;
      stopped = true;
      if (kill) attachTo.killTree(injector);
      fail(stoppedError());
    };
    const abortOnQuit = () => abort(false); // the injectors are already killed by then
    aborts.add(abortOnQuit);
    const key = opts.startKey;
    if (key != null) starting.set(key, () => abort());
    // Every await before the session exists is raced with a Stop and followed by this check, so a Stop at any point
    // (process lookup, version probe, injection, connecting) ends the attach right there.
    const step = async (p) => {
      const v = await Promise.race([p, failed]);
      if (stopped) throw stoppedError();
      return v;
    };
    const id = `attach-${++attachSeq}`;
    let timer;
    let socket = null;
    try {
      const state = attachTo.pidState(pid);
      if (!state) throw new Error(`Process ${pid} is not running`);
      if (state === 'denied') throw new Error(`Access denied: cannot attach to process ${pid}`);
      const proc = (await step(attachTo.listProcesses({ ownDirs }))).find((p) => p.pid === pid);
      if (!proc || (target.created && proc.created && target.created !== proc.created)) throw new Error(`Process ${pid} is not running`);
      let version = proc.version || null;
      const known = listening.get(pid);
      if (known && !(known.created && known.created === proc.created)) listening.delete(pid);
      // A process whose debugpy already listens (attached before, or a program that called debugpy.listen()) is
      // connected to directly: injecting again would call debugpy.listen() a second time, which debugpy refuses.
      for (const port of new Set([listening.get(pid)?.port, proc.debugPort].filter(attachTo.validPort))) {
        socket = await connectOnce(port).catch(() => null);
        if (stopped) throw stoppedError();
        if (socket) break;
      }
      if (!socket) {
        if (!proc.exe) throw new Error(`Access denied: cannot attach to process ${pid}`);
        const port = await step(freePort());
        const injecting = attachTo.inject({ exe: proc.exe, pid, port, vendorDir, isStopped: () => stopped,
          onChild: (c) => { injector = c; if (stopped) attachTo.killTree(c); } });
        // Also when a Stop won the race: the target's debugpy now listens there, and a later attach must connect to it
        // instead of injecting again.
        injecting.then(() => listening.set(pid, { port, created: proc.created }), () => {});
        ({ version } = await step(injecting));
        const alive = () => !stopped && !!attachTo.pidState(pid);
        const connecting = connectWithRetry(port, alive, ATTACH_TIMEOUT_MS, () => (stopped ? stoppedError()
          : !attachTo.pidState(pid) ? new Error(`Process ${pid} exited before the debugger connected`)
            : new Error(`Process ${pid} did not start the debugger within ${ATTACH_TIMEOUT_MS / 1000} seconds; it may be blocked in native code or waiting for input`)));
        // A socket that connects after a stop has nobody to talk to.
        connecting.then((s) => { if (stopped) s.destroy(); }, () => {});
        socket = await step(connecting);
      }
      if (stopped) throw stoppedError();
      socket.setNoDelay(true);
      const sock = socket;
      const dap = new DapClient(sock, (event, body) => send('debug:event', { id, event, body }));
      sessions.set(id, { dap, socket: sock, attach: pid });
      // Detaching, the target exiting and a lost connection all end an attach session through 'closed'.
      sock.on('close', () => {
        sessions.delete(id);
        forget(pid);
        send('debug:event', { id, event: 'closed', body: {} });
      });
      timer = setTimeout(() => fail(new Error(`debugpy did not start the debug session within ${HANDSHAKE_TIMEOUT_MS / 1000} seconds`)),
        HANDSHAKE_TIMEOUT_MS);
      await Promise.race([configure(dap, breakpoints, opts.exceptions, [], { redirectOutput: true }), failed]);
      log.info(`attached to pid ${pid} (${id})`);
      return { id, pid, version };
    } catch (err) {
      if (sessions.has(id)) {
        await Promise.race([sessions.get(id).dap.request('disconnect', { terminateDebuggee: false }).catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
        closeSession(id);
      } else socket?.destroy();
      forget(pid);
      throw err;
    } finally {
      clearTimeout(timer);
      aborts.delete(abortOnQuit);
      if (key != null) starting.delete(key);
    }
  });

  async function configure(dap, breakpoints, exceptions = { filters: ['uncaught'] }, pathMappings = [], extra = {}) {
    await dap.request('initialize', {
      clientID: 'pyide', clientName: 'PyIDE', adapterID: 'debugpy', locale: 'en', linesStartAt1: true, columnsStartAt1: true,
      pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false,
    });
    const initialized = dap.waitEvent('initialized');
    // debugpy answers attach only after configurationDone, so it is awaited last.
    // The bundled debugpy is not under site-packages, so justMyCode would take it for the program's own code: a Pause
    // while it is still starting the program would stop in debugpy's frames and show its locals.
    const attached = dap.request('attach', { justMyCode: true, rules: [{ module: 'debugpy', include: false }], redirectOutput: false,
      showReturnValue: true, subProcess: false, ...extra,
      // A Linux debugpy translates this side's backslash paths only when told the client is Windows.
      ...(pathMappings.length ? { pathMappings, clientOS: process.platform === 'win32' ? 'windows' : 'unix' } : {}) });
    attached.catch(() => {});
    await initialized;
    for (const bp of breakpoints) {
      const source = { path: pathMappings.length ? bp.path : longPath(bp.path) };
      await dap.request('setBreakpoints', { source, breakpoints: bp.lines, sourceModified: false }).catch(() => {});
    }
    await dap.request('setExceptionBreakpoints', exceptions).catch(() => {});
    await dap.request('configurationDone');
    await attached;
  }

  ipcMain.handle('debug:longPaths', (_e, paths) => paths.map((p) => longPath(String(p))));

  ipcMain.handle('debug:request', (_e, id, command, args) => {
    const s = sessions.get(id);
    if (!s) throw new Error('No debug session');
    if (command === 'setBreakpoints' && !s.remote && args?.source?.path) args = { ...args, source: { ...args.source, path: longPath(args.source.path) } };
    return s.dap.request(command, args);
  });

  // id null: stops the debug:start named startKey, which has not handed its id to the renderer yet.
  ipcMain.handle('debug:stop', async (_e, id, startKey) => {
    if (id == null) return starting.get(startKey)?.();
    const s = sessions.get(id);
    if (s) {
      // An attached process is only detached from, never ended (PyCharm's Stop on an attached process detaches).
      await Promise.race([s.dap.request('disconnect', { terminateDebuggee: !s.attach }).catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
      closeSession(id);
    }
    if (!s?.attach && procs.has(id)) killProcess(id);
  });
};
