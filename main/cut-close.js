// Before an update installs. The NSIS installer ends every process under the install folder about a second after it
// starts (docs/pitfalls.md), and Nano Studio Cut (resources\cut\nano-studio-cut.exe) is one of them, so a running Cut
// would lose what its autosave has not written yet. closeAll asks each Cut started from that folder to close as its
// close button does (WM_CLOSE posted to its main window): a Cut with nothing unsaved ends its session
// and exits; one with unsaved changes writes its autosave at once and asks the person whether to save. The installer
// starts only when all of them are gone; one still open after waitMs (the person has not answered, or chose Cancel)
// stops the update, which the caller says. Nothing is ever ended by force, and nothing waits longer than waitMs.
const { execFile } = require('child_process');
const path = require('path');

const EXE = 'nano-studio-cut.exe';
// Long enough to answer "Save changes?" and for a save to finish.
const WAIT_MS = 60000;
const POLL_MS = 300;

const run = (file, args, timeout = 15000) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
});

const inside = (file, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// -> [pid] of the Cut programs running from under dir (a Cut of another copy of Nano Studio is not this update's).
async function runningUnder(dir) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Name '${path.basename(EXE, '.exe')}' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)\`t$($_.Path)" }`]);
  if (out == null) return [];
  return out.split(/\r?\n/).map((l) => l.split('\t')).filter(([pid, file]) => /^\d+$/.test(pid) && file && inside(file, dir)).map(([pid]) => Number(pid));
}

// Posts WM_CLOSE to the visible main window of each pid (its title ends with "Nano Studio Cut"), as its close button
// does. Not taskkill without /F: that posts to one top-level window, which for Cut is winit's hidden event window, and
// nothing happens. -> how many windows were asked.
const CLOSE = 'Add-Type -TypeDefinition \'using System; using System.Text; using System.Runtime.InteropServices; public static class CutClose { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static int Ask(int[] ids) { int n = 0; EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(ids, p) >= 0 && IsWindowVisible(h)) { var s = new StringBuilder(512); GetWindowText(h, s, 512); if (s.ToString().EndsWith("Nano Studio Cut") && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) n++; } return true; }, IntPtr.Zero); return n; } }\'; [CutClose]::Ask(@(PIDS))';
async function askToClose(pids) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CLOSE.replace('PIDS', pids.map(Number).join(','))]);
  return Number(out) || 0;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// -> {asked: [pid], left: [pid]}: the Cut programs asked to close, and those still running after waitMs.
async function closeAll({ dir, waitMs = WAIT_MS, log } = {}) {
  const asked = await runningUnder(dir);
  if (!asked.length) return { asked, left: [] };
  log?.info?.(`asking Nano Studio Cut to close before the update (pid ${asked.join(', ')})`);
  const windows = await askToClose(asked);
  if (windows < asked.length) log?.warn?.(`asked ${windows} Cut windows for ${asked.length} programs`);
  let left = asked.filter(alive);
  for (const end = Date.now() + waitMs; left.length && Date.now() < end; await sleep(POLL_MS)) left = left.filter(alive);
  if (left.length) log?.warn?.(`Nano Studio Cut is still open (pid ${left.join(', ')}); not updating`);
  return { asked, left };
}

module.exports = { EXE, WAIT_MS, closeAll, runningUnder, askToClose, inside };
