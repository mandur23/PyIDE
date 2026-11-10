// A collaboration session without the app (docs/collab-coding-plan.md): main/collab/host.js and guest.js over a real
// loopback connection with the private tunnel's handshake, and a guest that sends what it likes. Checks: a wrong key
// gets nothing; a request to join waits for the host; a read-only guest's edits, saves and file operations are
// refused and change nothing; typing in a terminal the host did not allow, a port the host did not open and a run
// nobody answered do nothing; malformed messages and a flood drop the guest; a dropped connection resumes with every
// message delivered once; a sixth person is refused. An edit guest cannot change what runs on the host by itself
// (protocol.js READ_ONLY: a virtual environment of any name, node_modules, wrappers, lint and IDE settings, by a
// rename or through a junction too, and a document that becomes part of one while open), and none of it reaches the
// disk; the new hidden entries are neither listed nor read; ordinary source still syncs and saves. Usage: node verify/collab-session.mjs
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
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const KEPT = ['main.py', 'conftest.py', 'gradlew.bat', 'package.json', '.idea/workspace.xml', 'node_modules/left-pad/index.js', 'myenv/pyvenv.cfg',
  'myenv/Lib/site-packages/pkg.py', 'tools/data.txt', 'src/app.py'];
const SECRETS = ['id_ed25519', 'id_ecdsa', '.npmrc', '.pypirc', '.netrc', 'credentials.json', 'keys/server.ppk', 'keys/vault.kdbx', 'keys/app.jks', '.aws/credentials', '.docker/config.json'];
for (const rel of KEPT) put(rel, `# ${rel}\n`);
for (const rel of SECRETS) put(rel, 'SECRET\n');
fs.symlinkSync(path.join(root, '.idea'), path.join(root, 'ide-link'), 'junction');
const disk = () => KEPT.filter((rel) => rel !== 'main.py' && rel !== 'conftest.py').map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('|');
const before = disk();
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

  // ---------- what an edit guest may not change ----------
  let req = 100;
  const ask = async (msg) => {
    const n = ++req;
    const answer = () => a.heard.find((m) => (m.type === 'fs:result' || m.type === 'saved') && m.req === n);
    a.g.send({ ...msg, req: n });
    await until(answer);
    return answer() || {};
  };
  const refused = (r) => r.ok === false && r.code === 'protected' && typeof r.why === 'string' && /guests cannot change .*runs on the host/.test(r.error || '');
  const creates = [['x.pth', 'python', false], ['sitecustomize.py', 'python', false], ['myenv/Lib/site-packages/evil.py', 'venv', false],
    ['myenv/new.txt', 'venv', false], ['tools/pyvenv.cfg', 'venv', false], ['conda-meta', 'venv', true], ['node_modules/left-pad/evil.js', 'packages', false],
    ['gradlew', 'wrapper', false], ['mvnw.cmd', 'wrapper', false], ['build.gradle', 'build', false], ['eslint.config.js', 'lint', false],
    ['.idea/runConfigurations', 'settings', true], ['ide-link/evil.xml', 'settings', false], ['.vscode', 'settings', true], ['.husky', 'hooks', true],
    ['SiteCustomize.PY', 'python', false], ['src/Node_Modules', 'packages', true]];
  for (const [rel, why, dir] of creates) {
    const r = await ask({ type: 'fs:create', path: rel, dir });
    check(refused(r) && r.why === why && !fs.existsSync(path.join(root, rel)), `an edit guest cannot create ${rel} (${why}): ${r.code} "${String(r.error).slice(0, 80)}"`);
  }
  for (const [from, to] of [['main.py', 'x.pth'], ['main.py', 'myenv/main.py'], ['main.py', 'node_modules/main.py'], ['src', '.vscode'], ['src', 'conda-meta'],
    ['gradlew.bat', 'gradlew.txt'], ['myenv', 'notenv'], ['package.json', 'pkg.json']]) {
    const r = await ask({ type: 'fs:rename', from, to });
    check(refused(r) && fs.existsSync(path.join(root, from)) && !fs.existsSync(path.join(root, to)), `a rename ${from} -> ${to} is refused (${r.why})`);
  }
  for (const rel of ['gradlew.bat', '.idea/workspace.xml', 'myenv/Lib/site-packages/pkg.py', 'node_modules']) {
    const r = await ask({ type: 'fs:delete', path: rel });
    check(refused(r) && fs.existsSync(path.join(root, rel)), `deleting ${rel} is refused`);
  }
  // Documents: the guest's editor is told, and an op or a save that comes anyway is refused.
  const joined = async (rel, ticket) => {
    a.g.send({ type: 'doc:join', path: rel, ticket });
    await until(() => a.heard.some((m) => m.type === 'doc:synced' && m.path === rel && m.ticket === ticket));
    await sleep(100);
    return a.heard.filter((m) => m.type === 'readOnly' && m.path === rel).pop();
  };
  for (const [rel, why, ticket] of [['package.json', 'lint', 21], ['myenv/Lib/site-packages/pkg.py', 'venv', 22], ['.idea/workspace.xml', 'settings', 23], ['ide-link/workspace.xml', 'settings', 24]]) {
    check((await joined(rel, ticket))?.why === why, `opening ${rel}, the guest hears it is read-only (${why})`);
    a.g.send({ type: 'doc:op', path: rel, base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'import os\n' }] }] });
    await until(() => a.heard.some((m) => m.type === 'doc:failed' && m.path === rel));
    const failedDoc = a.heard.find((m) => m.type === 'doc:failed' && m.path === rel);
    const abs = path.join(root, ...rel.split('/'));
    check(failedDoc?.code === 'protected' && failedDoc.why === why && !docs.textOf(abs)?.text.includes('import os'), `an edit of ${rel} is refused, with why`);
    const r = await ask({ type: 'doc:save', path: rel });
    check(refused(r) && !events.some((e) => e.type === 'save' && pathKey(e.path) === pathKey(abs)), `saving ${rel} is refused`);
  }
  // A document already open when its folder becomes a virtual environment.
  check((await joined('tools/data.txt', 25)) === undefined, 'an ordinary file opens editable');
  fs.writeFileSync(path.join(root, 'tools', 'pyvenv.cfg'), 'home = C:\\Python\n');
  host.filesChanged({ created: [path.join(root, 'tools', 'pyvenv.cfg')] });
  await until(() => a.heard.some((m) => m.type === 'readOnly' && m.path === 'tools/data.txt' && m.why === 'venv'));
  check(a.heard.some((m) => m.type === 'readOnly' && m.path === 'tools/data.txt' && m.why === 'venv'), 'once its folder becomes a virtual environment, an open document turns read-only');
  a.g.send({ type: 'doc:op', path: 'tools/data.txt', base: 0, ops: [{ c: [{ at: 0, del: 0, ins: 'EVIL' }] }] });
  await until(() => a.heard.some((m) => m.type === 'doc:failed' && m.path === 'tools/data.txt'));
  check(a.heard.some((m) => m.type === 'doc:failed' && m.path === 'tools/data.txt' && m.code === 'protected') && !docs.textOf(path.join(root, 'tools', 'data.txt'))?.text.includes('EVIL'), 'and its edits are refused');
  check(JSON.stringify(disk()) === JSON.stringify(before), 'nothing protected changed on the host\'s disk');

  // ---------- secrets ----------
  a.g.send({ type: 'tree', path: '' });
  a.g.send({ type: 'tree', path: 'keys' });
  await until(() => a.got('tree').length >= 2);
  const names = a.got('tree').flatMap((m) => (m.entries || []).map((e) => e.name.toLowerCase()));
  check(names.includes('main.py') && names.includes('myenv') && SECRETS.map((rel) => rel.split('/')[0].toLowerCase()).filter((n) => n !== 'keys').concat(['server.ppk', 'vault.kdbx', 'app.jks']).every((n) => !names.includes(n)),
    'the new hidden files are not listed (id_ed25519, .npmrc, .aws/, *.ppk, *.kdbx, *.jks, ...)');
  let ticket = 30;
  for (const rel of SECRETS) {
    const n = ++ticket;
    a.g.send({ type: 'doc:join', path: rel, ticket: n });
    await until(() => a.heard.some((m) => m.ticket === n && (m.type === 'doc:failed' || m.type === 'doc:synced')));
    check(a.heard.some((m) => m.ticket === n && m.type === 'doc:failed' && m.code === 'hidden') && !a.heard.some((m) => m.ticket === n && m.type === 'doc:synced'), `${rel} cannot be read`);
  }

  // ---------- what an edit guest still does ----------
  const revOf = (rel) => a.heard.filter((m) => m.type === 'doc:synced' && m.path === rel).pop()?.rev;
  await joined('main.py', 50);
  a.g.send({ type: 'doc:op', path: 'main.py', base: revOf('main.py'), ops: [{ c: [{ at: 0, del: 0, ins: 'print(1)\n' }] }] });
  await until(() => docs.textOf(path.join(root, 'main.py'))?.text.startsWith('print(1)'));
  check(docs.textOf(path.join(root, 'main.py'))?.text === 'print(1)\n# main.py\n', 'an ordinary source file still syncs');
  a.g.send({ type: 'doc:save', path: 'main.py', req: 99 });
  await until(() => events.some((e) => e.type === 'save' && e.rel === 'main.py'));
  check(events.some((e) => e.type === 'save' && e.rel === 'main.py'), 'and its save reaches the host\'s window');
  const made = await ask({ type: 'fs:create', path: 'src/new.py', dir: false });
  const moved = await ask({ type: 'fs:rename', from: 'src/new.py', to: 'src/renamed.py' });
  check(made.ok && moved.ok && fs.existsSync(path.join(root, 'src', 'renamed.py')), 'it still creates and renames ordinary files');
  check(!events.some((e) => e.type === 'guestChanged'), 'the host is not told about ordinary files');
  await joined('conftest.py', 51);
  a.g.send({ type: 'doc:op', path: 'conftest.py', base: revOf('conftest.py'), ops: [{ c: [{ at: 0, del: 0, ins: '# fixture\n' }] }] });
  a.g.send({ type: 'doc:op', path: 'conftest.py', base: revOf('conftest.py') + 1, ops: [{ c: [{ at: 0, del: 0, ins: '#\n' }] }] });
  await until(() => docs.textOf(path.join(root, 'conftest.py'))?.text.startsWith('#\n# fixture'));
  check(docs.textOf(path.join(root, 'conftest.py'))?.text.startsWith('#\n# fixture') && events.filter((e) => e.type === 'guestChanged').length === 1
    && events.find((e) => e.type === 'guestChanged').rel === 'conftest.py', 'a guest may edit conftest.py, and the host is told once');

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
