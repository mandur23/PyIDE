// Port sharing's main process (main/features/port-sharing.js) in plain Node with a fake ipcMain, and the Ports window's
// script (renderer/features/port-sharing/index.js) in a vm with a fake `ide`. netstat is a stand-in (PYIDE_NETSTAT) that
// prints the listeners this script names or fails, the process list (PowerShell) is answered here through execFile, and
// bore is a stand-in (PYIDE_BORE) that prints an address and stays. Nothing leaves loopback.
// Checks: a netstat or a process list that fails is no "nothing listens": no tunnel stops, no key is lost, no port leaves
// the list, and the next good read catches up; a game server's port is kept by main and comes with ports:state, so a
// window that never heard of the server (another one, or the same one reloaded) still shares it privately and leaves it
// to automatic sharing; main refuses an automatic public share of it.
// Usage: node verify/port-sharing-core.mjs
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const require = createRequire(import.meta.url);
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (test, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(20); } return false; };
let passed = 0;
let failed = 0;
const check = (ok, label) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const work = mkdtempSync(path.join(tmpdir(), 'pyide-ports-core-'));
const table = path.join(work, 'listeners.json'); // {fail, rows: [{port, pid}]}
const runs = path.join(work, 'netstat-runs.txt');
const netstat = path.join(work, 'fake-netstat.cjs');
writeFileSync(netstat, `const fs = require('fs');
fs.appendFileSync(${J(runs)}, 'run\\n');
const { fail, rows } = JSON.parse(fs.readFileSync(${J(table)}, 'utf8'));
if (fail) { process.stderr.write('netstat: failed\\n'); process.exit(1); }
const v6 = process.argv.includes('TCPv6');
process.stdout.write('\\r\\nActive Connections\\r\\n\\r\\n  Proto  Local Address          Foreign Address        State           PID\\r\\n');
if (!v6) for (const r of rows) process.stdout.write('  TCP    127.0.0.1:' + r.port + '        0.0.0.0:0              LISTENING       ' + r.pid + '\\r\\n');
`);
const bore = path.join(work, 'fake-bore.cjs');
const boreLog = path.join(work, 'bore-args.txt');
writeFileSync(bore, `require('fs').appendFileSync(${J(boreLog)}, process.argv.slice(2).join(' ') + (process.env.PYIDE_BORE_SECRET ? ' keyed' : ' open') + '\\n');
setTimeout(() => process.stdout.write('listening at bore.pub:40123\\n'), 100);
setInterval(() => {}, 1000);
`);
writeFileSync(boreLog, '');
let rows = [];
let netstatFails = false;
const setNetstat = () => writeFileSync(table, J({ fail: netstatFails, rows }));
setNetstat();
const netstatRuns = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
Object.assign(process.env, { PYIDE_NETSTAT: J([process.execPath, netstat]), PYIDE_BORE: J([process.execPath, bore]), PYIDE_INSTALL_ROOT: path.join(work, 'root') });
delete process.env.PYIDE_CLOUDFLARED;

// The process list: programs this script "started" (their parent is this process, as the IDE's are), unless it fails.
let processesFail = false;
const procs = new Map();
const realChild = require('child_process');
const fakeExecFile = (cmd, args, options, done) => {
  if (cmd !== 'powershell') return realChild.execFile(cmd, args, options, done);
  setTimeout(() => {
    if (processesFail) { done(Object.assign(new Error('Command failed: powershell (timed out)'), { killed: true, signal: 'SIGTERM' }), ''); return; }
    const text = [...procs.values()].map((p) => `${p.pid}\t${process.pid}\t${p.name}\tC:\\Programs\\${p.name}\t${p.cmd}`).join('\r\n');
    done(null, Buffer.from(text, 'utf8').toString('latin1'));
  }, 20);
  return new EventEmitter();
};
const file = path.join(app, 'main', 'features', 'port-sharing.js');
const load = Module._load;
Module._load = function (request, parent, ...more) {
  if (request === 'child_process' && parent?.filename === file) return { ...realChild, execFile: fakeExecFile };
  return load.call(this, request, parent, ...more);
};
const sharing = require(file);
Module._load = load;

const handlers = new Map();
const quit = new EventEmitter();
let programCount = 1;
sharing.register({
  ipcMain: { handle: (channel, run) => handlers.set(channel, run) },
  app: { on: (event, run) => quit.on(event, run) },
  send: () => {},
  unpackedDir: app,
  programs: { count: () => programCount, onChange: () => {} },
});
const sender = Object.assign(new EventEmitter(), { id: 1 });
const call = (channel, ...args) => handlers.get(channel)({ sender }, ...args);
const tunnelOf = async (port) => (await call('ports:state')).tunnels.find((t) => t.port === port) || null;
const listed = async (port) => (await call('ports:state')).ports.some((p) => p.port === port);
// Waits for at least one whole poll after now: the one under way may have read before the change.
const polls = async () => { const at = netstatRuns(); return until(() => netstatRuns() >= at + 4, 15000); };
const cleanup = () => { programCount = 0; quit.emit('will-quit'); };
process.on('exit', () => { cleanup(); try { rmSync(work, { recursive: true, force: true }); } catch {} });

try {
  // ---------- a read that fails ----------
  procs.set(4242, { pid: 4242, name: 'java.exe', cmd: 'java -jar paper.jar nogui' });
  rows = [{ port: 18650, pid: 4242 }];
  setNetstat();
  await call('ports:state');
  check(await listed(18650), 'a server the IDE started is listed');
  const shared = await call('ports:share', 18650, { private: true });
  check(shared.tunnels.some((t) => t.port === 18650), 'it is shared privately');
  check(await until(async () => (await tunnelOf(18650))?.state === 'shared'), 'and the stand-in bore gives it an address');
  const key = sharing.privateShare(18650)?.key;
  check(!!key && readFileSync(boreLog, 'utf8').includes('keyed'), 'a key is made for it');

  netstatFails = true;
  setNetstat();
  check(await polls(), 'the list is read again while netstat fails');
  check((await tunnelOf(18650))?.state === 'shared' && sharing.privateShare(18650)?.key === key, `a netstat that fails stops no tunnel and keeps the key (${J(await tunnelOf(18650))})`);
  check(await listed(18650), 'and the server stays listed');
  netstatFails = false;
  setNetstat();
  await polls();

  // A listener appears while the process list fails: the snapshot is not taken, and the next good read takes it.
  procs.set(4343, { pid: 4343, name: 'node.exe', cmd: 'node server.js' });
  rows = [{ port: 18650, pid: 4242 }, { port: 18651, pid: 4343 }];
  processesFail = true;
  setNetstat();
  check(await polls(), 'the list is read again while the process list fails');
  check((await tunnelOf(18650))?.state === 'shared' && sharing.privateShare(18650)?.key === key, `a process list that fails stops no tunnel and keeps the key (${J(await tunnelOf(18650))})`);
  check(await listed(18650), 'and drops no server from the list');
  processesFail = false;
  check(await until(() => listed(18651), 15000), 'once it answers again, the new server is listed');
  check((await tunnelOf(18650))?.state === 'shared', 'and the share is still there');
  rows = [{ port: 18651, pid: 4343 }];
  setNetstat();
  check(await until(async () => !(await tunnelOf(18650)), 15000) && !sharing.privateShare(18650), 'a server that really stopped still takes its tunnel and its key with it');

  // ---------- game servers' ports ----------
  procs.set(4444, { pid: 4444, name: 'java.exe', cmd: 'java -jar paper.jar nogui' });
  rows = [{ port: 18651, pid: 4343 }, { port: 18652, pid: 4444 }];
  setNetstat();
  const told = await call('ports:gamePort', 18652);
  check(told?.games?.includes(18652), `ports:gamePort answers with the state, the port among the games (${J(told?.games)})`);
  check((await call('ports:state')).games.includes(18652), 'and every later ports:state has it, for any window');
  for (const bad of [0, 65536, -1, '18652', null, 1.5]) await call('ports:gamePort', bad);
  check(J((await call('ports:state')).games) === J([18652]), `a value that is no port is not taken (${J((await call('ports:state')).games)})`);
  check(await until(() => listed(18652), 15000), 'the game server is listed');
  const auto = await Promise.resolve(call('ports:share', 18652, { auto: true })).then(() => 'shared', (err) => err.message);
  check(/game server/i.test(auto) && !(await tunnelOf(18652)), `main refuses an automatic public share of a game server's port (${auto})`);
  check(!readFileSync(boreLog, 'utf8').includes('local 18652'), 'and starts no tunnel for it');
  const other = await Promise.resolve(call('ports:share', 18651, { auto: true })).then(() => 'shared', (err) => err.message);
  check(other === 'shared', `another port is still shared automatically (${other})`);
  await call('ports:unshare', 18651);
  const asked = await Promise.resolve(call('ports:share', 18652, { auto: true, private: true })).then(() => 'shared', (err) => err.message);
  check(asked === 'shared' && (await tunnelOf(18652))?.private, `a private share of it is not refused (${asked})`);
  await call('ports:unshare', 18652);
} catch (err) {
  check(false, err.stack || err.message);
}
cleanup();

// ---------- the Ports window, reloaded ----------
// The window's script with nothing but what main says: no ide.ports.gamePort call reached it.
async function portsWindow(initial, settings, refuse = new Set()) {
  const invoked = [];
  const notes = [];
  const on = new Map();
  const answer = (channel, ...args) => {
    invoked.push([channel, ...args]);
    if (channel === 'ports:share' && refuse.has(args[0])) return Promise.reject(new Error(`Error invoking remote method 'ports:share': Error: Port ${args[0]} is a game server's, which automatic sharing does not share publicly`));
    if (channel === 'ports:state' || channel === 'ports:setAdded' || channel === 'ports:share' || channel === 'ports:gamePort') return Promise.resolve(initial);
    if (channel === 'installer:toolchains') return Promise.resolve([]);
    return Promise.resolve(null);
  };
  const el = () => ({ append() {}, replaceChildren() {}, classList: { add() {}, toggle() {} }, dataset: {}, set onclick(_) {} });
  const ide = {
    util: { el, errorText: (e) => String(e?.message ?? e) },
    emit() {},
    on() {},
    api: { invoke: answer, on: (channel, run) => on.set(channel, run) },
    settings: { get: (key, fallback) => (key in settings ? settings[key] : fallback), set() {} },
    registerToolWindow: () => ({ isVisible: () => false }),
    notifications: { notify: (n) => notes.push(n) },
    ui: { confirm: async () => true, alert() {}, dialog() {} },
  };
  const context = vm.createContext({ ide, tr: (s) => s, console, setTimeout, clearTimeout, Promise });
  vm.runInContext(readFileSync(path.join(app, 'renderer', 'features', 'port-sharing', 'index.js'), 'utf8'), context);
  await sleep(20);
  return { ide, invoked, notes, changed: (st) => on.get('ports:changed')(st) };
}
{
  const row = (port) => ({ port, pid: 4444, address: '127.0.0.1', host: 'localhost', dial: '127.0.0.1', lan: [], proto: null, added: false, name: 'java.exe', cmd: '' });
  const base = { ports: [], added: [], tunnels: [], cloudflared: false, bore: true, games: [18652] };
  const w = await portsWindow(base, { 'ports.autoShare': true, 'ports.confirmShareTcp': false, 'ports.confirmShare': false });
  w.changed({ ...base, ports: [row(18652), row(18653)] });
  await sleep(50);
  const shares = w.invoked.filter((c) => c[0] === 'ports:share');
  check(!shares.some((c) => c[1] === 18652), `automatic sharing leaves a game server's port alone in a window that never started it (${J(shares)})`);
  check(shares.some((c) => c[1] === 18653 && c[2]?.private === false && c[2]?.auto === true), `and tells main a share it starts by itself is automatic (${J(shares)})`);
  w.invoked.length = 0;
  await w.ide.ports.share(18652);
  const manual = w.invoked.find((c) => c[0] === 'ports:share');
  check(manual?.[1] === 18652 && manual[2]?.private === true, `Share there gives the game server a private share (${J(manual)})`);
  w.invoked.length = 0;
  w.ide.ports.gamePort(18660);
  await sleep(20);
  check(w.invoked.some((c) => c[0] === 'ports:gamePort' && c[1] === 18660), 'ide.ports.gamePort tells main');
  check(w.ide.ports.state().games.includes(18660), 'and the window counts the port as a game at once');

  // A window whose state is older than main's: main refuses, and the window says nothing about it.
  const stale = await portsWindow({ ...base, games: [] }, { 'ports.autoShare': true }, new Set([18654]));
  stale.changed({ ...base, games: [], ports: [row(18654)] });
  await sleep(50);
  check(stale.invoked.some((c) => c[0] === 'ports:share' && c[1] === 18654) && !stale.notes.some((n) => /18654/.test(`${n.title} ${n.text}`)),
    `a refused automatic share is no error to show (${J(stale.notes.map((n) => n.title))})`);
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
