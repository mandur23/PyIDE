// A client for bore.pub, run by Port Sharing as its own process under the IDE's Electron as Node, so a game server's
// traffic stays off the main process:   bore-client.js local <port> --local-host <host> --to <server>
// It replaces bore.exe, which Microsoft Defender quarantines as a trojan on download, and takes the same arguments and
// prints the same address line. The protocol is bore v0.6.0's (src/shared.rs, src/client.rs): JSON frames ended by a NUL
// byte on port 7835. {"Hello":0} asks for a public port; the server answers {"Hello":<port>}, then sends "Heartbeat" and
// {"Connection":<id>}, and each connection is taken up on a new socket with {"Accept":<id>}, which then carries the
// player's bytes unframed.
// With PYIDE_BORE_SECRET (base64url, 32 bytes) a private share: each connection runs main/bore-gate.js first, and the
// local server sees only those that pass. The friend's side is
//   bore-client.js join --to <host:port> --listen 127.0.0.1:<port>
// a local listener for the game, where each connection dials the public port directly, not bore's control port.
const net = require('net');
const gate = require('./bore-gate');

// WebCrypto's ChaCha20-Poly1305 warns on stderr that it is experimental, and Port Sharing shows stderr's last line as
// the reason a tunnel failed.
process.removeAllListeners('warning');

const CONTROL_PORT = Number(process.env.PYIDE_BORE_CONTROL_PORT) || 7835;
const MAX_FRAME = 256;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_HANDSHAKES = 64;
const FAILED_NOTE_MS = 10000;
// A dead peer whose TCP never says so: Minecraft's own keep-alive ends the game's side, this ends the tunnel's.
const KEEP_ALIVE_MS = 30000;

const fail = (message) => { console.error(`bore: ${message}`); process.exit(1); };

// argv is visible to other processes and the app logs it, so the key comes through the environment and leaves it here.
function takeSecret() {
  const text = process.env.PYIDE_BORE_SECRET;
  delete process.env.PYIDE_BORE_SECRET;
  if (text === undefined) return null;
  const secret = Buffer.from(text, 'base64url');
  return secret.length === 32 ? secret : fail('the key is not valid');
}

// A process holding a key goes when the app that started it goes, however that ended: its stdin is the app's pipe.
function followParent() {
  for (const event of ['end', 'close']) process.stdin.on(event, () => process.exit(0));
  process.stdin.resume();
}

function dial(host, port, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, ...options });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error(`could not connect to ${host}:${port}: timed out`)));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.off('error', reject);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

const send = (socket, message) => socket.write(`${JSON.stringify(message)}\0`);

function readFrames(socket, onMessage) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end >= 0; end = buffered.indexOf(0)) {
      const frame = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 1);
      let message;
      try { message = JSON.parse(frame); } catch { return fail(`the server sent something that is not a message: ${frame.slice(0, 80)}`); }
      onMessage(message);
    }
    if (buffered.length > MAX_FRAME) fail('the server sent a message that is too long');
  });
}

// The remote socket stays paused until the local server is connected, so nothing the player sent is lost.
async function accept(id, { server, localHost, localPort }) {
  let remote;
  let local;
  try {
    remote = await dial(server, CONTROL_PORT);
    // dial's own listener is gone: a reset while the local server is reached would end the whole client.
    remote.on('error', () => {});
    send(remote, { Accept: id });
    local = await dial(localHost, localPort);
  } catch (err) {
    console.error(`connection exited with error: ${err.message}`);
    remote?.destroy();
    return;
  }
  if (remote.destroyed) {
    local.destroy();
    return;
  }
  const close = () => { remote.destroy(); local.destroy(); };
  for (const socket of [remote, local]) {
    socket.on('error', close);
    socket.on('close', close);
  }
  remote.pipe(local);
  local.pipe(remote);
}

// A tunnel's two sockets keep their own half-close: records still on their way must reach the far side after a FIN,
// and bore-gate.js decides when a half-open pair goes.
const HALF_OPEN = { allowHalfOpen: true };
const keptAlive = (...sockets) => { for (const socket of sockets) socket.setKeepAlive(true, KEEP_ALIVE_MS); };

// The local server hears of a connection only after its handshake. Limits are per tunnel, because bore hides the source
// address. With every slot taken the newcomer stays and an older handshake goes: refusing the newcomer would let a scanner
// that holds the slots open lock out every friend. Silent ones go first, since a friend speaks at once. A connection
// dropped before its Accept is left to bore, which closes it 10 s later: a flood costs a bounded number of sockets here.
function gatedAccept(secret, { server, localHost, localPort }) {
  const unproven = new Set(); // {abort, spoke}, oldest first
  let failed = 0;
  let notedAt = 0;
  const note = () => {
    failed++;
    if (Date.now() - notedAt < FAILED_NOTE_MS) return;
    notedAt = Date.now();
    console.error(`dropped ${failed} connections so far`);
  };
  const dropOne = () => {
    const victim = [...unproven].find((h) => !h.spoke) ?? unproven.values().next().value;
    unproven.delete(victim);
    victim.abort.abort();
  };
  return async (id) => {
    if (unproven.size >= MAX_HANDSHAKES) dropOne();
    const handshake = { abort: new AbortController(), spoke: false };
    unproven.add(handshake);
    let remote = null;
    let keys;
    try {
      remote = await dial(server, CONTROL_PORT, { ...HALF_OPEN, signal: handshake.abort.signal });
      send(remote, { Accept: id });
      keys = await gate.hostHandshake(remote, secret, { onHello: () => { handshake.spoke = true; } });
    } catch {
      remote?.destroy();
      return note();
    } finally { unproven.delete(handshake); }
    let local;
    try {
      local = await dial(localHost, localPort, HALF_OPEN);
    } catch (err) {
      console.error(`connection exited with error: ${err.message}`);
      remote.destroy();
      return undefined;
    }
    keptAlive(remote, local);
    gate.tunnel(remote, local, keys, 'host');
    return undefined;
  };
}

// The game's bytes wait in its paused socket until the far side has proved it holds the key: nothing leaves this
// computer for a relay posing as the host.
function join(value, secret) {
  const to = /^(.+):(\d+)$/.exec(value('--to') || '');
  const listen = /^127\.0\.0\.1:(\d+)$/.exec(value('--listen') || '');
  if (!secret || !to || !listen) fail('usage: join --to <host:port> --listen 127.0.0.1:<port>, with PYIDE_BORE_SECRET set');
  const host = to[1].replace(/^\[|\]$/g, '');
  const port = Number(to[2]);
  const server = net.createServer({ ...HALF_OPEN, pauseOnConnect: true }, async (game) => {
    game.setNoDelay(true);
    game.on('error', () => {});
    let wire = null;
    let keys;
    try {
      wire = await dial(host, port, HALF_OPEN);
      keys = await gate.clientHandshake(wire, secret);
    } catch (err) {
      console.error(`connection exited with error: ${err.message}`);
      wire?.destroy();
      game.destroy();
      return;
    }
    keptAlive(wire, game);
    gate.tunnel(wire, game, keys, 'client');
  });
  server.on('error', (err) => fail(['EADDRINUSE', 'EACCES'].includes(err.code) ? 'the port is taken' : err.message));
  server.listen(Number(listen[1]), '127.0.0.1', () => console.log(`listening at 127.0.0.1:${server.address().port}`));
}

async function main(args) {
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const secret = takeSecret();
  if (secret) followParent();
  if (args[0] === 'join') return join(value, secret);
  const target = { server: value('--to'), localHost: value('--local-host') || 'localhost', localPort: Number(args[1]) };
  if (args[0] !== 'local' || !target.server || !Number.isInteger(target.localPort)) fail('usage: local <port> --local-host <host> --to <server>');
  const control = await dial(target.server, CONTROL_PORT).catch((err) => fail(err.message));
  const take = secret ? gatedAccept(secret, target) : (id) => accept(id, target);
  let listening = false;
  const answer = setTimeout(() => fail(`no answer from ${target.server}`), CONNECT_TIMEOUT_MS);
  readFrames(control, (message) => {
    if (typeof message !== 'object' || message === null) return;
    if (message.Error) fail(`server error: ${message.Error}`);
    if (message.Challenge) fail('the server requires a secret');
    if (message.Hello !== undefined && !listening) {
      listening = true;
      clearTimeout(answer);
      console.log(`listening at ${target.server}:${message.Hello}`);
    }
    if (message.Connection) take(message.Connection);
  });
  control.on('error', (err) => fail(err.message));
  control.on('close', () => fail(`${target.server} closed the connection`));
  send(control, { Hello: 0 });
  return undefined;
}

main(process.argv.slice(2));
