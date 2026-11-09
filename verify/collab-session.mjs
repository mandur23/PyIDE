// A collaboration session without the app (docs/collab-coding-plan.md): main/collab/host.js and guest.js over a real
// loopback connection with the private tunnel's handshake, and a guest that sends what it likes. Checks: a wrong key
// gets nothing; a request to join waits for the host; a read-only guest's edits, saves and file operations are
// refused and change nothing; typing in a terminal the host did not allow, a port the host did not open and a run
// nobody answered do nothing; malformed messages and a flood drop the guest; a dropped connection resumes with every
// message delivered once; a sixth person is refused. Usage: node verify/collab-session.mjs
import { createRequire } from 'module';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createHost } = require('../main/collab/host.js');
const { createGuest, makeCode, parseCode } = require('../main/collab/guest.js');
const { createSharedDocs, loadFromDisk } = require('../main/shared-docs.js');
const { pathKey } = require('../main/path-case.js');
process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return false; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-session-'));
fs.writeFileSync(path.join(root, 'a.py'), 'x = 1\n');
fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
const docs = createSharedDocs({ keyOf: pathKey, load: loadFromDisk });
const events = [];
const typed = [];
const taps = new Set();
const terminal = { tapOutput: (fn) => { taps.add(fn); return () => taps.delete(fn); }, writeTo: (id, data) => { typed.push(data); return true; }, alive: (id) => id === 7 };
const host = createHost({ root, sharedDocs: docs, hostName: 'Host', terminal, onEvent: (e) => events.push(e) });
const port = await host.listen();
const code = makeCode({ address: `127.0.0.1:${port}`, key: host.secret, name: 'Host' });

// A guest whose messages the suite sends itself, and what it hears.
function guest(name, c = code) {
  const heard = [];
  const states = [];
  const g = createGuest({ code: c, name, onEvent: (e) => { if (e.type === 'message') heard.push(e.msg); else states.push(e.state); } });
  return { g, heard, states, got: (type) => heard.filter((m) => m.type === type), last: () => states[states.length - 1] };
}
const requestOf = (name) => until(() => events.some((e) => e.type === 'request' && e.name === name));

try {
  // ---------- the code and the handshake ----------
  check(parseCode(`see ${code}.`).port === port, 'a code is found in pasted text');
  for (const bad of [code.replace(/key=[^&]+/, 'key=abc'), code.replace('key=', 'k%65y='), code.replace(/addr=[^&]+/, 'addr=x'), 'nanostudio:join?addr=1.2.3.4:5']) {
    let refused = false;
    try { parseCode(bad); } catch (e) { refused = e.code === 'badCode'; }
    check(refused, `a damaged code is refused (${bad.replace(/key=[A-Za-z0-9_-]{20,}/, 'key=…').slice(0, 60)})`);
  }
  const wrong = guest('Mallory', makeCode({ address: `127.0.0.1:${port}`, key: Buffer.alloc(32, 7), name: 'x' }));
  await until(() => wrong.last() === 'ended', 8000);
  check(wrong.last() === 'ended' && !events.some((e) => e.type === 'request' && e.name === 'Mallory'), 'a wrong key gets nothing: no request reaches the host');
  const silent = net.connect(port, '127.0.0.1');
  silent.on('error', () => {});
  let spoke = false;
  silent.on('data', () => { spoke = true; });
  await sleep(500);
  check(!spoke, 'the host says nothing to a socket that says nothing');
  silent.destroy();

  // ---------- joining ----------
  const a = guest('Ann');
  await requestOf('Ann');
  await sleep(300);
  check(a.last() === 'waiting' && !a.got('welcome').length, 'a guest waits until the host accepts');
  host.accept(events.find((e) => e.type === 'request' && e.name === 'Ann').id, { role: 'read' });
  await until(() => a.got('welcome').length);
  check(a.got('welcome')[0]?.role === 'read', 'accepted view only');
  const annId = a.got('welcome')[0].you;

  // ---------- a view-only guest ----------
  a.g.send({ type: 'doc:join', path: 'a.py', ticket: 1 });
  await until(() => a.got('doc:synced').length);
  check(a.got('doc:synced')[0]?.text === 'x = 1\n', 'a view-only guest reads a file');
  a.g.send({ type: 'doc:op', path: 'a.py', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'EVIL' }] }] });
  a.g.send({ type: 'doc:save', path: 'a.py', req: 1 });
  a.g.send({ type: 'fs:create', path: 'new.py', dir: false, req: 2 });
  a.g.send({ type: 'fs:rename', from: 'a.py', to: 'b.py', req: 3 });
  a.g.send({ type: 'fs:delete', path: 'a.py', req: 4 });
  await until(() => a.got('fs:result').length === 3 && a.got('saved').length === 1);
  check(a.got('doc:failed').some((m) => m.code === 'readOnly') && !docs.textOf(path.join(root, 'a.py'))?.text.includes('EVIL'), 'a view-only guest\'s edit is refused');
  check(a.got('saved')[0]?.code === 'readOnly' && a.got('fs:result').every((m) => !m.ok && m.code === 'readOnly'), 'its save and file operations are refused');
  check(fs.readFileSync(path.join(root, 'a.py'), 'utf8') === 'x = 1\n' && !fs.existsSync(path.join(root, 'new.py')) && !fs.existsSync(path.join(root, 'b.py')), 'and nothing changed on disk');

  // ---------- running, the terminal, ports ----------
  a.g.send({ type: 'run:request', path: '.env', req: 5 });
  a.g.send({ type: 'run:request', path: '../outside.py', req: 6 });
  await until(() => a.got('run:answer').length === 2);
  check(a.got('run:answer').every((m) => !m.allowed) && !events.some((e) => e.type === 'runRequest'), 'a run request for a hidden or outside path never reaches the host');
  a.g.send({ type: 'run:request', path: 'a.py', req: 7 });
  await until(() => events.some((e) => e.type === 'runRequest'));
  a.g.send({ type: 'run:request', path: 'a.py', req: 8 });
  await until(() => a.got('run:answer').length === 3);
  check(a.got('run:answer')[2]?.code === 'busy', 'one request at a time');
  check(!host.runAnswer({ by: annId, req: 99, allowed: true }), 'an answer to a request never made does nothing');
  host.runAnswer({ by: annId, req: 7, allowed: false });
  await until(() => a.got('run:answer').length === 4);
  check(a.got('run:answer')[3]?.allowed === false, 'the guest hears the host declined');

  a.g.send({ type: 'term:input', data: 'del /q *\r' });
  check(host.shareTerminal(7, 'cmd', { cols: 80, rows: 24 }), 'the host shares a terminal');
  await until(() => a.got('term:state').some((m) => m.shared));
  a.g.send({ type: 'term:input', data: 'del /q *\r' });
  for (const tap of taps) tap(7, 'C:\\> ');
  await until(() => a.got('term').length);
  check(a.got('term').some((m) => m.data === 'C:\\> '), 'the guest sees the terminal\'s output');
  await sleep(200);
  check(typed.length === 0, 'typing before the host allows it reaches nothing');
  a.g.send({ type: 'term:ask' });
  await until(() => events.some((e) => e.type === 'termRequest'));
  host.termAnswer({ by: annId, allowed: true });
  await until(() => a.got('term:answer').length);
  a.g.send({ type: 'term:input', data: 'dir\r' });
  await until(() => typed.length);
  check(typed.join() === 'dir\r', 'once allowed, the typing reaches the terminal');
  host.stopTerminal();
  a.g.send({ type: 'term:input', data: 'late\r' });
  await sleep(200);
  check(typed.join() === 'dir\r', 'after the sharing stops, nothing more');

  const server = net.createServer((s) => s.end('secret service'));
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  a.g.send({ type: 'tcp:open', cid: 1, port: server.address().port });
  await until(() => a.got('tcp:close').length);
  check(a.got('tcp:close')[0]?.cid === 1 && !a.got('tcp:data').length, 'a port the host did not open is not reached');
  host.sharePorts([server.address().port]);
  a.g.send({ type: 'tcp:open', cid: 2, port: server.address().port });
  await until(() => a.got('tcp:data').length);
  check(Buffer.from(a.got('tcp:data')[0]?.data || '', 'base64').toString() === 'secret service', 'an opened port is reached');
  server.close();

  // ---------- resuming ----------
  host.setRole(annId, 'edit');
  await until(() => a.got('role').length);
  a.g.dropConnection();
  for (let i = 0; i < 20; i++) a.g.send({ type: 'chat', text: `offline ${i}` });
  await until(() => a.last() === 'online' && a.states.includes('reconnecting'), 15000);
  await until(() => events.filter((e) => e.type === 'chat').length === 20, 5000);
  const chats = events.filter((e) => e.type === 'chat').map((e) => e.text);
  check(chats.length === 20 && chats.every((t, i) => t === `offline ${i}`), 'after a drop the session resumes and every message arrives once, in order');

  // ---------- refusals ----------
  for (let i = 0; i < 30; i++) a.g.send({ type: 'doc:op', path: 'a.py', base: -1, ops: [] });
  await until(() => events.some((e) => e.type === 'left' && e.id === annId && e.why === 'protocol'), 5000);
  check(events.some((e) => e.type === 'left' && e.id === annId && e.why === 'protocol'), 'a guest that keeps sending malformed messages is dropped');
  const b = guest('Bea');
  await requestOf('Bea');
  host.accept(events.find((e) => e.type === 'request' && e.name === 'Bea').id);
  await until(() => b.got('welcome').length);
  for (let i = 0; i < 6000; i++) b.g.send({ type: 'cursor', path: null, ranges: [] });
  await until(() => events.some((e) => e.type === 'left' && e.name === 'Bea'), 8000);
  check(events.some((e) => e.type === 'left' && e.name === 'Bea' && e.why === 'flood'), 'a guest that floods the host is dropped');
  const crowd = ['C1', 'C2', 'C3', 'C4'].map((n) => guest(n));
  for (const n of ['C1', 'C2', 'C3', 'C4']) await requestOf(n);
  const fifth = guest('C5');
  await until(() => fifth.last() === 'ended', 8000);
  check(fifth.last() === 'ended' && !events.some((e) => e.type === 'request' && e.name === 'C5'), 'with four guests in or waiting, a fifth is refused (5 people at most)');
  host.stop();
  await until(() => crowd.every((c) => c.last() === 'ended'), 5000);
  check(crowd.every((c) => c.last() === 'ended'), 'stopping ends every guest, waiting ones too');
} catch (err) {
  check(false, `collab-session: ${err.stack}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
