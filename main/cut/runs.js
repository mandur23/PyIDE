// Which run of the app wrote a marker (a session, an open export sink), and whether that run is still alive. A run is
// {pid, run, started}: `run` is unique to one start of this module, so a marker from an earlier start in the same
// process (a test, or a pid the system reused) is not mistaken for this one.
const crypto = require('crypto');
const os = require('os');

// A run counts as started before this computer did only by more than this, so a clock set forward after the start (a
// time sync) does not make a running process look like one from before a restart.
const BOOT_SLACK_MS = 10 * 60000;

function createRun() {
  const self = { pid: process.pid, run: crypto.randomBytes(6).toString('hex'), started: Date.now() };
  // A pid is trusted only for a run that started after this computer did: after a restart it may be another program's.
  function alive(marker) {
    if (!marker || typeof marker !== 'object') return false;
    if (marker.run === self.run) return true;
    const pid = Number(marker.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    if (!(Number(marker.started) >= Date.now() - os.uptime() * 1000 - BOOT_SLACK_MS)) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  }
  return { ...self, alive, mark: (extra) => ({ pid: self.pid, run: self.run, started: self.started, ...extra }) };
}

module.exports = { createRun };
