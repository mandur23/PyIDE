// Port sharing, like VS Code's Ports view: the TCP ports that programs started from the IDE (Run, Launchers, the
// terminal) listen on, plus ports the user added (a server started elsewhere), and a public address for any of them,
// with no account and no router or firewall change, nothing system-wide. Each port is probed once for what it speaks:
// a web server (http or https) gets a Cloudflare quick tunnel (cloudflared) and an https address; any other TCP server
// (a game server, a socket server) gets a bore tunnel (bore.pub) and a host:port address. Both tools come from the
// Install Manager. A tunnel lives as long as its server listens, until the user stops sharing, or until the IDE quits.
// PYIDE_CLOUDFLARED, PYIDE_BORE (tests): a JSON array, the program and its first arguments run in place of the tool.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { createToolchains } = require('../installer/toolchains');

const POLL_MS = 3000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BORE_SERVER = 'bore.pub';
const BORE_RE = /listening at ([\w.-]+:\d+)/;
const ANSI = /\x1b\[[0-9;]*m/g;

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 32 << 20, encoding: 'latin1' }, (err, stdout) => resolve(err ? '' : stdout));
});

// netstat -ano's listening TCP sockets as [{port, pid, address}]. Its state column is localized ("LISTENING",
// "수신 대기"), so a listener is told by its idle foreign address.
async function listeners() {
  const [out, v6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])]);
  const seen = new Map();
  for (const line of `${out}\n${v6}`.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (!/^TCP$/i.test(p[0]) || p.length < 5 || !/^(0\.0\.0\.0|\[::\]):0$/.test(p[2])) continue;
    const at = p[1].lastIndexOf(':');
    const address = p[1].slice(0, at);
    const port = Number(p[1].slice(at + 1));
    const pid = Number(p[p.length - 1]);
    if (!pid || !port) continue;
    if (!seen.has(port)) seen.set(port, { port, pid, address });
  }
  return [...seen.values()];
}

// host: how the user and cloudflared's URL name a listener (localhost for loopback and every interface, else the one
// address it is bound to). dial: the address a probe and bore connect to, in the listener's own family: a server on
// [::1] alone (Vite, Node 17+ on Windows) refuses 127.0.0.1.
const V6_LOCAL = /^\[::1?\]$/;
const hostOf = (address) => (V6_LOCAL.test(address) ? '[::1]' : /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/.test(address) ? 'localhost' : address);
const dialOf = (address) => (V6_LOCAL.test(address) ? '::1' : /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/.test(address) ? '127.0.0.1' : address.replace(/^\[|\]$/g, ''));

// The addresses other computers on the same network reach a server on: this computer's private IPv4 addresses, for a
// server bound to every interface or to one of them.
function lanAddresses(address) {
  const all = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
    .map((i) => i.address);
  if (address === '0.0.0.0' || address === '[::]') return all;
  return all.includes(address) ? [address] : [];
}

// What a listener speaks: 'http' (it answers an HTTP request), 'https' (it completes a TLS handshake), else 'tcp'.
function speaksHttp(socket, port, ready) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; socket.destroy(); resolve(/^HTTP\/\d/.test(buf)); } };
    socket.setTimeout(1500, finish);
    socket.on('error', finish);
    socket.on('data', (d) => { buf += d.toString('latin1'); if (buf.length >= 5) finish(); });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.once(ready, () => socket.write(`HEAD / HTTP/1.0\r\nHost: localhost:${port}\r\n\r\n`));
  });
}
async function probe(h, port) {
  if (await speaksHttp(net.connect({ host: h, port }), port, 'connect')) return 'http';
  const secure = await new Promise((resolve) => {
    const socket = tls.connect({ host: h, port, rejectUnauthorized: false, ...(net.isIP(h) ? {} : { servername: h }) });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.once('secureConnect', () => { socket.destroy(); resolve(true); });
  });
  return secure ? 'https' : 'tcp';
}

// Every process with its parent, name and command line (one PowerShell call, a few hundred ms).
async function processes() {
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ForEach-Object { '{0}\t{1}\t{2}\t{3}\t{4}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.ExecutablePath,($_.CommandLine -replace '[\\r\\n\\t]',' ') }"]);
  const text = Buffer.from(out, 'latin1').toString('utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, name, exe, cmd] = line.split('\t');
    if (pid && /^\d+$/.test(pid)) map.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name, exe: exe || '', cmd: cmd || '' });
  }
  return map;
}

exports.register = ({ ipcMain, app, send }) => {
  const toolchains = createToolchains();
  const tool = (name, env) => {
    if (process.env[env]) {
      try { const argv = JSON.parse(process.env[env]); if (Array.isArray(argv) && argv.length) return argv; } catch {}
    }
    const s = toolchains.status(name);
    return s.installed ? [path.join(s.home, `${name}.exe`)] : null;
  };
  const cloudflared = () => tool('cloudflared', 'PYIDE_CLOUDFLARED');
  const bore = () => tool('bore', 'PYIDE_BORE');

  // [{port, pid, address, host, dial, lan, proto: 'http'|'https'|'tcp'|null, added, name, cmd}]: what IDE-started
  // programs and the ports the user added listen on. proto is null until a probe answers.
  let ports = [];
  let added = new Set(); // ports the user added, listed whatever started them
  // "port:pid" -> Promise<proto>, so each server is probed once. A probe connects and sends a request, which a program
  // that accepts a single connection would take as its client, so nothing is probed in the background: only while
  // the Ports window is shown (ports:probe) and for a port being shared.
  const protos = new Map();
  function probeRow(row) {
    const key = `${row.port}:${row.pid}`;
    if (!protos.has(key)) {
      const job = probe(row.dial, row.port).catch(() => 'tcp');
      protos.set(key, job);
      job.then((proto) => {
        const now = ports.find((r) => r.port === row.port && r.pid === row.pid);
        if (now && now.proto !== proto) { now.proto = proto; changed(); }
      });
    }
    return protos.get(key);
  }
  let snapshot = ''; // the last netstat answer, so the process list is read again only when listeners change
  let tree = new Map();
  const tunnels = new Map(); // port -> {child, state: 'starting' | 'shared' | 'failed', url, error, log}
  let timer = null;
  let polling = null;

  const state = () => ({
    ports,
    added: [...added],
    tunnels: [...tunnels].map(([port, t]) => ({ port, kind: t.kind, state: t.state, url: t.url || null, error: t.error || null, log: t.state === 'shared' ? '' : t.log.slice(-1500) })),
    cloudflared: !!cloudflared(),
    bore: !!bore(),
  });
  const changed = () => send('ports:changed', state());

  // A process the IDE started, directly or through others (a shell in the terminal, cmd.exe running mvnw, Maven
  // forking the application). Electron's own helpers and the IDE's tools are not programs the user runs.
  function ideProcess(pid) {
    for (let p = tree.get(pid), hops = 0; p && hops < 64; p = tree.get(p.ppid), hops++) {
      if (p.ppid === process.pid) return true;
    }
    return false;
  }
  const isTool = (p) => !p || (p.exe && path.resolve(p.exe) === path.resolve(process.execPath)) || /^cloudflared(\.exe)?$/i.test(p.name)
    || /debugpy|pydevd|jdtls|pyright|langserver/i.test(p.cmd);
  // A JVM started for the debugger listens on its JDWP port too; that port is the debugger's, not a server.
  const debuggerPorts = (p) => [...p.cmd.matchAll(/jdwp=[^\s"]*address=(?:[\w.]+:)?(\d+)/g)].map((m) => Number(m[1]));

  async function poll() {
    const list = await listeners();
    const key = list.map((l) => `${l.port}:${l.pid}`).sort().join();
    if (key !== snapshot) {
      snapshot = key;
      if (list.length) tree = await processes();
      const next = [];
      for (const l of list) {
        const p = tree.get(l.pid);
        const mine = added.has(l.port);
        if (!mine && (!ideProcess(l.pid) || isTool(p) || debuggerPorts(p).includes(l.port))) continue;
        const known = ports.find((o) => o.port === l.port && o.pid === l.pid)?.proto ?? null;
        next.push({ ...l, host: hostOf(l.address), dial: dialOf(l.address), lan: lanAddresses(l.address), proto: known, added: mine,
          name: p?.name || '', cmd: (p?.cmd || '').slice(0, 400) });
      }
      // A server that went away is probed again when it comes back.
      for (const key of [...protos.keys()]) if (!next.some((r) => `${r.port}:${r.pid}` === key)) protos.delete(key);
      next.sort((a, b) => a.port - b.port);
      const was = JSON.stringify(ports);
      ports = next;
      // A shared server that stopped listening takes its tunnel with it.
      for (const port of [...tunnels.keys()]) if (!ports.some((p) => p.port === port)) stop(port);
      if (JSON.stringify(ports) !== was) changed();
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      polling = poll().catch(() => {});
      await polling;
      schedule();
    }, POLL_MS);
  }

  function stop(port) {
    const t = tunnels.get(port);
    if (!t) return false;
    tunnels.delete(port);
    try { t.child?.kill(); } catch {}
    changed();
    return true;
  }

  ipcMain.handle('ports:state', async () => {
    if (!timer) { await poll().catch(() => {}); schedule(); }
    return state();
  });
  // Looks again now (a run just started), instead of at the next poll.
  ipcMain.handle('ports:refresh', async () => { snapshot = ''; await poll().catch(() => {}); return state(); });

  // Tells what every listed server speaks (the renderer asks while the Ports window is shown); answers arrive with
  // ports:changed.
  ipcMain.handle('ports:probe', () => { for (const row of ports) if (!row.proto) probeRow(row); return true; });

  // The ports the user added (the renderer keeps them); the list is read again at once.
  ipcMain.handle('ports:setAdded', async (_e, list) => {
    added = new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536));
    snapshot = '';
    await poll().catch(() => {});
    if (!timer) schedule();
    return state();
  });

  // -> the tunnel's state; its address arrives with ports:changed once the tool reports it.
  ipcMain.handle('ports:share', async (_e, port) => {
    const row = ports.find((p) => p.port === port);
    if (!row) throw Object.assign(new Error(`Nothing the IDE started listens on port ${port}`), { expected: true });
    if (tunnels.has(port)) return state();
    // Listed before the probe (seconds for a server that does not answer), so Stop Sharing meanwhile cancels it.
    const t = { kind: null, state: 'starting', url: null, error: null, log: '' };
    tunnels.set(port, t);
    changed();
    const proto = row.proto || await probeRow(row);
    if (tunnels.get(port) !== t) return state();
    const kind = proto === 'tcp' ? 'bore' : 'cloudflared';
    const argv = kind === 'bore' ? bore() : cloudflared();
    if (!argv) {
      tunnels.delete(port);
      changed();
      throw Object.assign(new Error(`${kind} is not installed`), { expected: true, code: 'missing', tool: kind });
    }
    t.kind = kind;
    // cloudflared checks no certificate of the local server: a development https server's is self-signed.
    const args = kind === 'bore'
      ? ['local', String(port), '--local-host', row.dial, '--to', BORE_SERVER]
      : ['tunnel', '--no-autoupdate', '--url', `${proto}://${row.host}:${port}`, ...(proto === 'https' ? ['--no-tls-verify'] : [])];
    // A program Windows will not start (Smart App Control or an antivirus blocking it, a damaged file) throws here
    // (spawn UNKNOWN) instead of emitting 'error'.
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), ...args], { windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    } catch (err) {
      tunnels.delete(port);
      changed();
      throw Object.assign(new Error(`Windows did not start ${path.basename(argv[0])} (${err.code || err.message})`), { expected: true, code: 'blocked', tool: kind, file: argv[0] });
    }
    t.child = child;
    // The address is printed before Cloudflare serves it. Opened that early, a resolver caches "no such name" and the
    // address fails for minutes, so it counts as shared once cloudflared has registered a connection to Cloudflare.
    // Each is taken from its chunk as it arrives: cloudflared prints a long connectivity report between the two, which
    // pushes the address out of the kept log tail.
    // bore prints its address once its server has given it a port, so that line alone means shared.
    let registered = kind === 'bore';
    let address = null;
    const read = (chunk) => {
      const text = chunk.toString().replace(ANSI, '');
      t.log = (t.log + text).slice(-4000);
      address ||= (kind === 'bore' ? BORE_RE.exec(t.log)?.[1] : URL_RE.exec(t.log)?.[0]) || null;
      registered ||= /Registered tunnel connection/i.test(t.log);
      if (address && registered && !t.url && tunnels.get(port) === t) {
        Object.assign(t, { url: address, state: 'shared' });
        changed();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const end = (why) => {
      if (tunnels.get(port) !== t) return;
      const lastLine = t.log.trim().split(/\r?\n/).pop() || '';
      Object.assign(t, { state: 'failed', url: null, error: why || lastLine || `${kind} stopped` });
      changed();
    };
    child.on('error', (err) => end(err.message));
    child.on('exit', (code) => end(code ? `${kind} exited with code ${code}: ${t.log.trim().split(/\r?\n/).pop() || ''}` : null));
    changed();
    return state();
  });
  ipcMain.handle('ports:unshare', (_e, port) => { stop(port); return state(); });

  app.on('will-quit', () => {
    clearTimeout(timer);
    for (const port of [...tunnels.keys()]) stop(port);
  });
};
