// The test client's game window (Windows): found through the JVM that listens on the debug port (Gradle may hide its
// arguments in an argument file, and its daemon is not our child), placed beside the IDE or kept on top, brought to the
// front, and sent F3+T to reload resources. One PowerShell helper with a few Win32 calls, started on first use, takes
// JSON lines {id, op, ...} and answers {id, result} or {id, error}.
const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class PyideGame {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  public static void Dpi() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static bool Alive(long h) { return IsWindow(new IntPtr(h)); }
  public static bool Place(long h, int x, int y, int w, int hh, bool top) {
    IntPtr p = new IntPtr(h);
    if (IsIconic(p)) ShowWindow(p, 9);
    return SetWindowPos(p, new IntPtr(top ? -1 : -2), x, y, w, hh, 0x0040);
  }
  public static bool Top(long h, bool top) { return SetWindowPos(new IntPtr(h), new IntPtr(top ? -1 : -2), 0, 0, 0, 0, 0x0013); }
  public static bool Front(long h) {
    IntPtr p = new IntPtr(h);
    if (IsIconic(p)) ShowWindow(p, 9);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    try { BringWindowToTop(p); SetForegroundWindow(p); } finally { if (attached) AttachThreadInput(me, fg, false); }
    for (int i = 0; i < 20 && GetForegroundWindow() != p; i++) Thread.Sleep(25);
    return GetForegroundWindow() == p;
  }
  static void Key(byte vk, bool up) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), up ? 2u : 0u, UIntPtr.Zero); Thread.Sleep(60); }
  // F3+T in the game, then the window that had the keyboard gets it back.
  public static bool Reload(long h) {
    IntPtr back = GetForegroundWindow();
    if (!Front(h)) return false;
    Thread.Sleep(150);
    Key(0x72, false); Key(0x54, false); Key(0x54, true); Key(0x72, true);
    Thread.Sleep(100);
    if (back != IntPtr.Zero && back != new IntPtr(h)) Front(back.ToInt64());
    return true;
  }
}
'@
[PyideGame]::Dpi()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = $null
  try {
    $q = $line | ConvertFrom-Json
    $id = $q.id
    $r = switch ($q.op) {
      'find' {
        $c = Get-NetTCPConnection -LocalPort ([int]$q.port) -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -First 1
        if ($c) {
          $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
          if ($p) { @{ pid = $p.Id; hwnd = $p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle } }
        }
      }
      'window' {
        $p = Get-Process -Id ([int]$q.pid) -ErrorAction SilentlyContinue
        if ($p) { @{ pid = $p.Id; hwnd = $p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle } }
      }
      'place' { [PyideGame]::Place([long]$q.hwnd, [int]$q.x, [int]$q.y, [int]$q.width, [int]$q.height, [bool]$q.top) }
      'top' { [PyideGame]::Top([long]$q.hwnd, [bool]$q.top) }
      'front' { [PyideGame]::Front([long]$q.hwnd) }
      'reload' { [PyideGame]::Reload([long]$q.hwnd) }
      'alive' { [PyideGame]::Alive([long]$q.hwnd) }
      default { throw "unknown op $($q.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; result = $r } | ConvertTo-Json -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

let helper = null; // {child, calls: Map(id -> {resolve, reject}), seq}

function start() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { child, calls: new Map(), seq: 0, err: '' };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const call = h.calls.get(msg.id);
      if (!call) continue;
      h.calls.delete(msg.id);
      if (msg.error) call.reject(new Error(msg.error)); else call.resolve(msg.result ?? null);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { h.err = (h.err + d).slice(-2000); });
  const gone = () => {
    if (helper === h) helper = null;
    for (const call of h.calls.values()) call.reject(new Error(`The window helper ended${h.err ? `: ${h.err.trim()}` : ''}`));
    h.calls.clear();
  };
  child.on('exit', gone);
  child.on('error', gone);
  child.stdin.on('error', () => {});
  return h;
}

function call(op, args = {}, timeoutMs = 20000) {
  if (process.platform !== 'win32') return Promise.reject(new Error('The game window can be arranged on Windows only'));
  if (!helper) helper = start();
  const h = helper;
  const id = ++h.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.calls.delete(id); reject(new Error(`The window helper did not answer ${op}`)); }, timeoutMs);
    h.calls.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    h.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  });
}

const int = (v) => Math.round(Number(v)) || 0;
const handleOf = (hwnd) => { const n = Number(hwnd); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('No game window'); return n; };

// The game's process and window: {pid, hwnd (0 until it has one), title}, or null while no JVM listens on the port.
async function find({ port, pid }) {
  if (pid) return call('window', { pid: int(pid) });
  const p = int(port);
  if (p < 1 || p > 65535) throw new Error('No debug port');
  return call('find', { port: p });
}

// The IDE's window keeps the left part of its screen's work area, the game the right part (a third or more of it).
function placeBeside(win, screen, hwnd, top) {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const gameWidth = Math.max(480, Math.round(area.width * 0.4));
  const ide = { x: area.x, y: area.y, width: area.width - gameWidth, height: area.height };
  win.setBounds(ide);
  const game = process.platform === 'win32' ? screen.dipToScreenRect(win, { x: area.x + ide.width, y: area.y, width: gameWidth, height: area.height })
    : { x: area.x + ide.width, y: area.y, width: gameWidth, height: area.height };
  return call('place', { hwnd: handleOf(hwnd), ...game, top: !!top });
}

const setTop = (hwnd, top) => call('top', { hwnd: handleOf(hwnd), top: !!top });
const front = (hwnd) => call('front', { hwnd: handleOf(hwnd) });
const reload = (hwnd) => call('reload', { hwnd: handleOf(hwnd) });

function stop() {
  helper?.child.stdin.end();
  helper = null;
}

module.exports = { find, placeBeside, setTop, front, reload, stop };
