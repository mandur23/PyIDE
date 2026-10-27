// Port sharing, like VS Code's Ports view: the TCP ports that programs started from the IDE (Run, Launchers, the
// terminal) listen on, and a public https address for any of them through a Cloudflare quick tunnel (cloudflared
// from the Install Manager; no account, no router or firewall change, nothing system-wide). A tunnel lives as long as
// its server listens, until the user stops sharing, or until the IDE quits.
// PYIDE_CLOUDFLARED (tests): a JSON array, the program and its first arguments run in place of cloudflared.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createToolchains } = require('../installer/toolchains');

const POLL_MS = 3000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 32 << 20, encoding: 'latin1' }, (err, stdout) => resolve(err ? '' : stdout));
});

// netstat -ano's listening TCP sockets as [{port, pid, address}]. Its state column is localized ("LISTENING",
// "수신 대기"), so a listener is told by its idle foreign address.
async function listeners() {
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  const v6 = await run('netstat', ['-ano', '-p', 'TCPv6']);
  const seen = new Map();
  for (const line of `${out}\n${v6}`.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (!/^TCP$/i.test(p[0]) || p.length < 5 || !/^(0\.0\.0\.0|\[::\]):0$/.test(p[2])) continue;
    const at = p[1].lastIndexOf(':');
    const address = p[1].slice(0, at);
    const port = Number(p[1].slice(at + 1));
    const pid = Number(p[p.length - 1]);
    // Only what this computer's browser reaches as localhost: loopback or every interface.
    if (!pid || !port || !/^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\])$/.test(address)) continue;
    if (!seen.has(port)) seen.set(port, { port, pid, address });
  }
  return [...seen.values()];
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
  const cloudflared = () => {
    if (process.env.PYIDE_CLOUDFLARED) {
      try { const argv = JSON.parse(process.env.PYIDE_CLOUDFLARED); if (Array.isArray(argv) && argv.length) return argv; } catch {}
    }
    const s = toolchains.status('cloudflared');
    return s.installed ? [path.join(s.home, 'cloudflared.exe')] : null;
  };

  let ports = []; // [{port, pid, address, name, cmd}]: what IDE-started programs listen on
  let snapshot = ''; // the last netstat answer, so the process list is read again only when listeners change
  let tree = new Map();
  const tunnels = new Map(); // port -> {child, state: 'starting' | 'shared' | 'failed', url, error, log}
  let timer = null;
  let polling = null;

  const state = () => ({
    ports,
    tunnels: [...tunnels].map(([port, t]) => ({ port, state: t.state, url: t.url || null, error: t.error || null })),
    cloudflared: !!cloudflared(),
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
        if (!ideProcess(l.pid) || isTool(p) || debuggerPorts(p).includes(l.port)) continue;
        next.push({ ...l, name: p.name, cmd: p.cmd.slice(0, 400) });
      }
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

  // -> the tunnel's state; its address arrives with ports:changed once cloudflared reports it.
  ipcMain.handle('ports:share', (_e, port) => {
    if (!ports.some((p) => p.port === port)) throw Object.assign(new Error(`Nothing the IDE started listens on port ${port}`), { expected: true });
    if (tunnels.has(port)) return state();
    const argv = cloudflared();
    if (!argv) throw Object.assign(new Error('cloudflared is not installed'), { expected: true, code: 'missing' });
    const t = { state: 'starting', url: null, error: null, log: '' };
    tunnels.set(port, t);
    const child = spawn(argv[0], [...argv.slice(1), 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    t.child = child;
    const read = (chunk) => {
      t.log = (t.log + chunk.toString()).slice(-4000);
      const m = URL_RE.exec(t.log);
      if (m && !t.url && tunnels.get(port) === t) {
        Object.assign(t, { url: m[0], state: 'shared' });
        changed();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const end = (why) => {
      if (tunnels.get(port) !== t) return;
      const lastLine = t.log.trim().split(/\r?\n/).pop() || '';
      Object.assign(t, { state: 'failed', url: null, error: why || lastLine || 'cloudflared stopped' });
      changed();
    };
    child.on('error', (err) => end(err.message));
    child.on('exit', (code) => end(code ? `cloudflared exited with code ${code}: ${t.log.trim().split(/\r?\n/).pop() || ''}` : null));
    changed();
    return state();
  });
  ipcMain.handle('ports:unshare', (_e, port) => { stop(port); return state(); });

  app.on('will-quit', () => {
    clearTimeout(timer);
    for (const port of [...tunnels.keys()]) stop(port);
  });
};
