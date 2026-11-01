// main/bore-client.js against a stand-in of bore's server that follows src/server.rs of bore v0.6.0: the frames it sends
// and expects, a heartbeat, and players connecting to the public port. Plain Node: no window and no network.
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { frame, standInBore } from './stand-in-bore.mjs';

const client =path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main', 'bore-client.js');
let failed = 0;
let passed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const listen = (server) => new Promise((r) => { server.listen(0, '127.0.0.1', () => r(server.address().port)); });
const until = async (test, label, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = test(); if (v) return v; await new Promise((r) => { setTimeout(r, 20); }); }
  throw new Error(`timeout: ${label}`);
};

function start(controlPort, localPort) {
  const child = spawn(process.execPath, [client, 'local', String(localPort), '--local-host', '127.0.0.1', '--to', '127.0.0.1'],
    { env: { ...process.env, PYIDE_BORE_CONTROL_PORT: String(controlPort) }, windowsHide: true });
  const run = { child, out: '', err: '', code: undefined };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  child.on('exit', (code) => { run.code = code; });
  return run;
}

const local = net.createServer((s) => {
  s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d])));
  s.on('error', () => {});
});
const localPort = await listen(local);

const bore = standInBore();
const controlPort = await listen(bore.server);
const run = start(controlPort, localPort);
try {
  await until(() => /listening at 127\.0\.0\.1:41234/.test(run.out), 'address line');
  check(true, 'prints the address line bore.exe prints, from a reply cut in two chunks');
  check(JSON.stringify(bore.seen.first[0]) === '{"Hello":0}', `asks for any port (${JSON.stringify(bore.seen.first[0])})`);

  bore.seen.control.write(Buffer.concat([frame('Heartbeat'), frame('Heartbeat')]));
  await new Promise((r) => { setTimeout(r, 100); });
  check(run.code === undefined, 'heartbeats are ignored');

  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  bore.seen.control.write(frame({ Connection: ids[0] }));
  bore.seen.control.write(frame({ Connection: ids[1] }));
  const [a, b] = await Promise.all(ids.map((id) => until(() => bore.seen.accepted.get(id), `accept ${id}`)));
  check(true, 'each connection is accepted on a new socket with {"Accept":id}, and two can be open together');

  const replies = new Map([[a, ''], [b, '']]);
  for (const s of [a, b]) s.on('data', (d) => replies.set(s, replies.get(s) + d));
  a.write('first');
  b.write('second');
  await until(() => replies.get(a) === 'echo:first' && replies.get(b) === 'echo:second', 'echoes');
  check(true, 'bytes pass both ways, each on its own connection, the player\'s first bytes included');

  const big = Buffer.alloc(3 << 20, 0x61);
  let got = 0;
  a.removeAllListeners('data');
  a.on('data', (d) => { got += d.length; });
  a.write(big);
  await until(() => got >= big.length, 'large transfer', 15000);
  check(true, 'a 3 MB burst arrives whole');

  a.destroy();
  await new Promise((r) => { setTimeout(r, 100); });
  check(run.code === undefined, 'a player leaving does not end the tunnel');

  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => { dead.close(r); });
  const orphan = start(controlPort, deadPort);
  await until(() => /listening at/.test(orphan.out), 'second client');
  const before = bore.seen.first.length;
  const control2 = bore.seen.control;
  control2.write(frame({ Connection: '33333333-3333-4333-8333-333333333333' }));
  await until(() => bore.seen.first.length > before, 'accept with the local server gone');
  await until(() => /connection exited with error/.test(orphan.err), 'local failure logged');
  check(orphan.code === undefined, 'a local server that refuses ends that connection, not the tunnel');
  orphan.child.kill();

  bore.seen.control = null;
  bore.server.close();
  for (const s of [b]) s.destroy();
  run.child.kill();
} catch (err) {
  check(false, `${err.message} (out: ${run.out}, err: ${run.err})`);
  run.child.kill();
}

const refused = standInBore({ hello: { Error: 'port already in use' } });
const refusedPort = await listen(refused.server);
const r1 = start(refusedPort, localPort);
await until(() => r1.code !== undefined, 'refused exit').catch(() => {});
check(r1.code === 1 && /server error: port already in use/.test(r1.err), `a server error ends the client with its message (${r1.code}, ${r1.err.trim()})`);
refused.server.close();

const secret = standInBore({ hello: { Challenge: '44444444-4444-4444-8444-444444444444' } });
const secretPort = await listen(secret.server);
const r2 = start(secretPort, localPort);
await until(() => r2.code !== undefined, 'challenge exit').catch(() => {});
check(r2.code === 1 && /requires a secret/.test(r2.err), 'a server that asks for a secret is refused clearly');
secret.server.close();

const gone = net.createServer();
const gonePort = await listen(gone);
await new Promise((r) => { gone.close(r); });
const r3 = start(gonePort, localPort);
await until(() => r3.code !== undefined, 'connect failure exit').catch(() => {});
check(r3.code === 1 && r3.err.includes('bore:'), `a server that cannot be reached ends the client with a reason (${r3.err.trim()})`);

const closing = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => { s.write(frame({ Hello: 41000 })); setTimeout(() => s.destroy(), 100); }); });
const closingPort = await listen(closing);
const r4 = start(closingPort, localPort);
await until(() => r4.code !== undefined, 'server close exit').catch(() => {});
check(r4.code === 1 && /closed the connection/.test(r4.err), 'losing the server ends the client, so Port Sharing shows the tunnel failed');
closing.close();
local.close();

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
