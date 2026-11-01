// A client for bore.pub, run by Port Sharing as its own process under the IDE's Electron as Node, so a game server's
// traffic stays off the main process:   bore-client.js local <port> --local-host <host> --to <server>
// It replaces bore.exe, which Microsoft Defender quarantines as a trojan on download, and takes the same arguments and
// prints the same address line. The protocol is bore v0.6.0's (src/shared.rs, src/client.rs): JSON frames ended by a NUL
// byte on port 7835. {"Hello":0} asks for a public port; the server answers {"Hello":<port>}, then sends "Heartbeat" and
// {"Connection":<id>}, and each connection is taken up on a new socket with {"Accept":<id>}, which then carries the
// player's bytes unframed.
const net = require('net');

const CONTROL_PORT = Number(process.env.PYIDE_BORE_CONTROL_PORT) || 7835;
const MAX_FRAME = 256;
const CONNECT_TIMEOUT_MS = 10000;

const fail = (message) => { console.error(`bore: ${message}`); process.exit(1); };

function dial(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
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
    send(remote, { Accept: id });
    local = await dial(localHost, localPort);
  } catch (err) {
    console.error(`connection exited with error: ${err.message}`);
    remote?.destroy();
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

async function main(args) {
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const target = { server: value('--to'), localHost: value('--local-host') || 'localhost', localPort: Number(args[1]) };
  if (args[0] !== 'local' || !target.server || !Number.isInteger(target.localPort)) fail('usage: local <port> --local-host <host> --to <server>');
  const control = await dial(target.server, CONTROL_PORT).catch((err) => fail(err.message));
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
    if (message.Connection) accept(message.Connection, target);
  });
  control.on('error', (err) => fail(err.message));
  control.on('close', () => fail(`${target.server} closed the connection`));
  send(control, { Hello: 0 });
}

main(process.argv.slice(2));
