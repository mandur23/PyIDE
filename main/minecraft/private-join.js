// The friend's side of a private server: one main/bore-client.js join process per server, a local port the game connects
// to, and the key handed over through the child's environment, never its arguments. A process lives until Craft quits,
// or until its server is removed or gets a new key. Its stdin is this process's pipe, so it also goes if Craft is killed.
// PYIDE_BORE (tests): a JSON array, the program and its first arguments run in place of the client.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const READY_MS = 15000;
// Packaged, the client runs from the unpacked folder (package.json build.asarUnpack).
const CLIENT = path.join(__dirname, '..', 'bore-client.js').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');

function clientArgv(env = process.env) {
  try {
    const argv = JSON.parse(env.PYIDE_BORE || 'null');
    if (Array.isArray(argv) && argv.length) return argv;
  } catch {}
  return [process.execPath, CLIENT];
}

// A port the game can use now, for a server not joined yet. The process binds it itself later, and start() takes another
// if something got there first.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

function createPrivateJoin({ argv = clientArgv } = {}) {
  const joins = new Map(); // address (lower case) -> {child, key, ready: Promise<port>}

  // -> the port it listens on. taken: the port is someone else's, and the caller may ask for another.
  function launch(address, key, port) {
    const program = argv();
    const child = spawn(program[0], [...program.slice(1), 'join', '--to', address, '--listen', `127.0.0.1:${port}`],
      { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYIDE_BORE_SECRET: key } });
    const ready = new Promise((resolve, reject) => {
      let said = '';
      const refuse = (message, taken = false) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(message), { expected: true, taken }));
      };
      const timer = setTimeout(() => { child.kill(); refuse('The private connection did not start in time'); }, READY_MS);
      const read = (chunk) => {
        said = `${said}${chunk}`.slice(-2000);
        const m = /listening at 127\.0\.0\.1:(\d+)/.exec(said);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', (err) => refuse(`The private connection could not start: ${err.message}`));
      child.once('exit', () => refuse(/the port is taken/.test(said) ? 'The port is taken' : 'The private connection stopped', /the port is taken/.test(said)));
    });
    return { child, key, ready };
  }

  // -> once the process has gone, and with it its port, which a kill alone does not free yet.
  const stop = (address) => {
    const id = address.toLowerCase();
    const join = joins.get(id);
    if (!join) return Promise.resolve();
    joins.delete(id);
    return new Promise((resolve) => {
      if (join.child.exitCode !== null || join.child.signalCode !== null) return resolve();
      join.child.once('close', resolve);
      join.child.kill();
      return undefined;
    });
  };

  // -> the port the game connects to: wanted while it is free, else one the system picks. One start per address at a
  // time: two at once would both find nothing running, and the process launched first would never be stopped.
  const pending = new Map(); // address (lower case) -> the start() in progress
  function start(options) {
    const id = options.address.toLowerCase();
    const job = (pending.get(id) || Promise.resolve()).catch(() => {}).then(() => begin(options));
    pending.set(id, job);
    const done = () => { if (pending.get(id) === job) pending.delete(id); };
    job.then(done, done);
    return job;
  }
  async function begin({ address, key, port }) {
    const id = address.toLowerCase();
    const running = joins.get(id);
    if (running?.key === key) return running.ready;
    await stop(address);
    const join = launch(address, key, port || 0);
    joins.set(id, join);
    const forget = () => { if (joins.get(id) === join) joins.delete(id); };
    join.child.once('exit', forget);
    try {
      return await join.ready;
    } catch (err) {
      forget();
      if (!err.taken) throw err;
      const again = launch(address, key, 0);
      joins.set(id, again);
      again.child.once('exit', () => { if (joins.get(id) === again) joins.delete(id); });
      return again.ready;
    }
  }

  const stopAll = () => Promise.all([...joins.keys()].map(stop));
  return { start, stop, stopAll, running: () => [...joins.keys()] };
}

module.exports = { createPrivateJoin, freePort };
