// Runs a feature file's disk-heavy functions on a worker thread, so the main process (and with it every window's IPC)
// never waits on thousands of file reads. The feature file is also the worker's source: it is evaluated from text,
// which works from inside the packaged app.asar too, and it answers {id, op, args} messages when started with its
// role (see the `workerData.role` check at the end of main/features/search.js).
const fs = require('fs');
const { Worker } = require('worker_threads');

function fileWorker(file, role) {
  let worker = null;
  let seq = 0;
  const waiting = new Map();
  const start = () => {
    worker = new Worker(fs.readFileSync(file, 'utf8'), { eval: true, workerData: { role } });
    worker.unref();
    worker.on('message', ({ id, result, error }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (error !== undefined) w?.reject(new Error(error)); else w?.resolve(result);
    });
    const fail = (err) => {
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error(`${role} worker stopped`)));
  };
  return (op, ...args) => {
    if (!worker) start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });
  };
}

module.exports = { fileWorker };
