// A server folder holds pyide-server.running while a process Nano Studio started there runs: {pid, started (ms), dir}.
// The window's record of what runs goes with the window, and the server does not (an app that crashed or was killed
// leaves its java.exe running): the marker is how the next start, or another Nano Studio, knows the folder is in use.
// Windows gives a pid to a new process soon after the old one ends, so a marker counts only while its pid is a Java
// process that started when the marker says.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARKER = 'pyide-server.running';
// The marker is written just after the spawn, so the process started a moment before it.
const START_SLACK_MS = 15000;
const markerOf = (dir) => path.join(dir, MARKER);
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function write(dir, pid) {
  try { fs.writeFileSync(markerOf(dir), `${JSON.stringify({ pid, started: Date.now(), dir: path.resolve(dir) })}\n`); } catch {}
}
// Removed only while it still names pid: a Rerun's new process has written its own by the time the old one closes.
function clear(dir, pid) {
  if (pid !== undefined && read(dir)?.pid !== pid) return;
  try { fs.rmSync(markerOf(dir), { force: true }); } catch {}
}
// A marker copied along with its folder (an import, a rename) names another folder: it says nothing about this one.
function read(dir) {
  let m;
  try { m = JSON.parse(fs.readFileSync(markerOf(dir), 'utf8')); } catch { return null; }
  if (!m || !Number.isInteger(m.pid) || m.pid <= 0 || !Number.isFinite(m.started) || typeof m.dir !== 'string') return null;
  return sameDir(m.dir, dir) ? m : null;
}

// -> 'alive' | 'gone' | null (could not tell: PowerShell did not answer).
function probe(pid, started) {
  try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return Promise.resolve('gone'); }
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + ' ' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } else { 'none' }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      const [name, at] = String(out).trim().split(/\s+/);
      if (name === 'none') return resolve('gone');
      if (!at) return resolve(null);
      resolve(/^javaw?$/i.test(name) && Math.abs(Number(at) - started) < START_SLACK_MS ? 'alive' : 'gone');
    });
  });
}
const answers = new Map(); // `${pid}:${started}` -> {at, state}
const FRESH_MS = 4000;
async function state(m) {
  const key = `${m.pid}:${m.started}`;
  const known = answers.get(key);
  if (known && (known.state === 'gone' || Date.now() - known.at < FRESH_MS)) return known.state;
  const s = await probe(m.pid, m.started);
  if (s) answers.set(key, { at: Date.now(), state: s });
  return s;
}

// The process a folder's marker names that still runs -> {pid, started}, or null. A marker whose process is gone is
// removed; one that cannot be checked is kept and taken as not running (a busy port still stops a second server).
async function leftOver(dir) {
  const m = read(dir);
  if (!m) {
    if (fs.existsSync(markerOf(dir))) clear(dir);
    return null;
  }
  const s = await state(m);
  if (s === 'gone') clear(dir, m.pid);
  return s === 'alive' ? { pid: m.pid, started: m.started } : null;
}

// Ends the process a marker names, whole tree, without asking it to save: nothing here can reach its console.
// -> whether it is gone.
async function end(dir) {
  const m = read(dir);
  if (!m || await probe(m.pid, m.started) !== 'alive') { clear(dir); return true; }
  await new Promise((resolve) => { spawn('taskkill', ['/pid', String(m.pid), '/T', '/F'], { windowsHide: true }).on('close', resolve).on('error', resolve); });
  for (let i = 0; i < 50; i++) {
    try { process.kill(m.pid, 0); } catch (err) { if (err.code === 'ESRCH') break; }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  answers.delete(`${m.pid}:${m.started}`);
  const gone = await probe(m.pid, m.started) !== 'alive';
  if (gone) clear(dir, m.pid);
  return gone;
}

module.exports = { MARKER, write, clear, read, leftOver, end };
