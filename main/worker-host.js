// Runs a feature file's disk-heavy functions on a worker thread, so the main process (and with it every window's IPC)
// never waits on thousands of file reads. The feature file is also the worker's source: it is evaluated from text,
// which works from inside the packaged app.asar too, and it answers {id, op, args} messages when started with its
// role (see the `workerData.role` check at the end of main/features/search.js).
//
// call(op, ...args) waits for the answer however long it takes. call.with({timeout, signal, resend}, op, ...args) can
// be abandoned: when it runs longer than `timeout` ms (code ETIMEDOUT) or its `signal` aborts (code ABORT_ERR), it is
// rejected and, if the worker is already running it, the worker is terminated (a user's regex can loop for hours and
// there is no other way to stop it). The requests queued behind it are sent again to a fresh worker, except those
// made with resend: false, which are rejected instead (an op that writes files must not run twice).
const fs = require('fs');
const { Worker } = require('worker_threads');

const errorWith = (message, code) => Object.assign(new Error(message), { code });

function fileWorker(file, role) {
  let worker = null;
  let seq = 0;
  // id -> {op, args, resolve, reject, timeout, resend, timer, abandoned}, in the order the worker answers them: the
  // first one is the one it runs now, so a timeout counts from when the requests before it were answered.
  const waiting = new Map();
  const head = () => waiting.values().next().value;

  const start = () => {
    const w = (worker = new Worker(fs.readFileSync(file, 'utf8'), { eval: true, workerData: { role } }));
    w.unref();
    w.on('message', ({ id, result, error }) => {
      if (worker !== w) return;
      const r = waiting.get(id);
      if (!r) return;
      waiting.delete(id);
      clearTimeout(r.timer);
      next();
      if (r.abandoned) return;
      if (error !== undefined) r.reject(new Error(error)); else r.resolve(result);
    });
    // Events of a worker this host already replaced (terminated, or an 'exit' after its 'error') are ignored: they
    // would otherwise reject the requests of the worker that replaced it.
    const fail = (err) => {
      if (worker !== w) return;
      worker = null;
      const all = [...waiting.values()];
      waiting.clear();
      for (const r of all) {
        clearTimeout(r.timer);
        if (!r.abandoned) r.reject(err);
      }
    };
    w.on('error', fail);
    w.on('exit', () => fail(new Error(`${role} worker stopped`)));
  };

  // The worker just started the first request waiting: arm its timeout, or stop it at once if it was abandoned.
  const next = () => {
    const r = head();
    if (!r) return;
    if (r.abandoned) restart();
    else if (r.timeout && !r.timer) r.timer = setTimeout(() => abandon(r, errorWith(`${role} ${r.op} took longer than ${r.timeout} ms`, 'ETIMEDOUT')), r.timeout);
  };

  // Rejects a request now. One still queued is dropped when its turn comes; the running one stops the worker.
  const abandon = (r, err) => {
    if (r.abandoned || waiting.get(r.id) !== r) return;
    r.abandoned = true;
    clearTimeout(r.timer);
    r.reject(err);
    if (head() === r) restart();
  };

  const restart = () => {
    const old = worker;
    worker = null;
    old?.terminate();
    for (const [id, r] of waiting) {
      if (r.abandoned || !r.resend) {
        waiting.delete(id);
        clearTimeout(r.timer);
        if (!r.abandoned) r.reject(errorWith(`${role} worker was restarted`, 'ERESTARTED'));
      }
    }
    if (!waiting.size) return;
    start();
    for (const [id, r] of waiting) worker.postMessage({ id, op: r.op, args: r.args });
    next();
  };

  const call = ({ timeout, signal, resend = true }, op, args) => {
    if (signal?.aborted) return Promise.reject(errorWith(`${role} ${op} was cancelled`, 'ABORT_ERR'));
    if (!worker) start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const r = { id, op, args, resolve, reject, timeout, resend, timer: null, abandoned: false };
      worker.postMessage({ id, op, args });
      waiting.set(id, r);
      if (head() === r) next();
      signal?.addEventListener('abort', () => abandon(r, errorWith(`${role} ${op} was cancelled`, 'ABORT_ERR')), { once: true });
    });
  };
  const host = (op, ...args) => call({}, op, args);
  host.with = (opts, op, ...args) => call(opts, op, args);
  return host;
}

module.exports = { fileWorker };
