// Watches each running server for an end nobody asked for, a freeze, and lag (health.js says what the evidence means),
// and tells the window: minecraft:health {dir, event, ...}. It never stops, restarts or changes a server by itself; an
// automatic restart is the window's, after this says one is due.
// - An end is expected when "stop" (or a proxy's "end") went to the server's stdin, which every stop of the app goes
//   through (Stop, Rerun, a restart, the quit gate, an update, Windows ending the session), when the app is quitting,
//   or when the server says an operator stopped it. Anything else is a crash, whatever the exit code.
// - A freeze: the console silent and the status ping (ping.js, to the server's own port) unanswered for two minutes,
//   counted only after the server said Done.
// - Lag: "Can't keep up" lines, Paper's tps (asked through the players session, so the answer stays out of the console
//   the owner reads; it is in latest.log like the session's own list query), the JVM's GC log (-Xlog:gc to
//   .nano/gc.log, which launch() adds for Java 9 and later), and the process's CPU from one PowerShell a minute for every
//   server at once.
// PYIDE_MC_HEALTH_MS (tests): {"tick", "quiet", "firstPing", "every", "recheck", "failing", "baseline", "pingTimeout", "evaluate",
// "sustain", "cpu", "tps", "delays"} in ms, to shorten the clock.
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./health');
const { ping } = require('./ping');

const TAIL_LINES = 300;
const GC_FILE = path.join('.nano', 'gc.log');
const GC_LOG_ARG = '-Xlog:gc:file=.nano/gc.log:uptime:filecount=2,filesize=2m';
const DEFAULTS = { autoRestart: false, hang: true, overload: true };
const STOP_LINE = /^(stop|end|shutdown|restart)$/i;

const timing = () => {
  let t = {};
  try { t = JSON.parse(process.env.PYIDE_MC_HEALTH_MS || '{}') || {}; } catch {}
  return { tick: 5000, quiet: 120000, firstPing: 30000, every: 15000, failing: 90000, evaluate: 30000, sustain: 60000, cpu: 60000, tps: 120000, recheck: 60000, baseline: 5000, pingTimeout: 5000, delays: [10000, 30000], ...t };
};
const keyOf = (dir) => path.resolve(dir).toLowerCase();

// From the first "stop" (or "end", ...) written to a server's stdin, by anyone, the server is stopping: proc.stopAsked is
// true and proc emits 'stopAsked' once. While it stops, the stop logic alone writes to it and ends it: a backup, a health
// query, a players poll or a freeze verdict would make it print (which re-arms the window's 60 s of silence) or end it
// by another path. Idempotent: main/features/minecraft.js marks every server it starts, watch() a process of a test.
function markStops(proc) {
  const write = proc?.stdin?.write;
  if (!write || proc.stopAsked !== undefined) return;
  proc.stopAsked = false;
  proc.stdin.write = function stdinWrite(chunk, ...rest) {
    const r = write.call(this, chunk, ...rest);
    if (!proc.stopAsked && String(chunk).split(/\r?\n/).some((l) => STOP_LINE.test(l.trim()))) {
      proc.stopAsked = true;
      proc.emit?.('stopAsked');
    }
    return r;
  };
}

function createHealthMonitor({ send, readServer, writeServer, describe = () => ({}), log = () => {}, now = Date.now, ramMB = Math.round(os.totalmem() / H.MB), pingServer = ping }) {
  const T = timing();
  const policy = H.createRestartPolicy({ now, delays: T.delays });
  const watched = new Map(); // key -> watch
  const reports = new Map(); // key -> the last unexpected end, until the server starts again or the owner closes it
  let quitting = false;

  const settingsOf = (dir) => {
    let h = null;
    try { h = readServer(dir)?.health; } catch {}
    return { ...DEFAULTS, ...(h && typeof h === 'object' && !Array.isArray(h) ? h : {}) };
  };
  function setSettings(dir, patch = {}) {
    const desc = readServer(dir);
    const next = { ...settingsOf(dir) };
    for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    writeServer(dir, { ...desc, health: next });
    return next;
  }
  const emit = (dir, event, extra) => send('minecraft:health', { dir, event, ...extra });
  const gameHere = (dir) => {
    try { return fs.readdirSync(path.join(path.dirname(path.dirname(dir)), 'instances')).length > 0; } catch { return false; }
  };

  // Before the spawn: the GC log of the run before is not this run's.
  function prepare(dir) {
    try {
      fs.mkdirSync(path.join(dir, '.nano'), { recursive: true });
      for (const n of fs.readdirSync(path.join(dir, '.nano'))) if (/^gc\.log(\.\d+)?$/.test(n)) fs.rmSync(path.join(dir, '.nano', n), { force: true });
    } catch {}
  }

  // proc: the ChildProcess of a server. info: {dir, kind, memory, port, host, java, paper, query(command, match, ms)}.
  function watch(proc, info) {
    const { dir } = info;
    const k = keyOf(dir);
    const started = now();
    reports.delete(k);
    emit(dir, 'started');
    const tail = [];
    let partial = '';
    const hang = H.createHangWatch({ now, quietMs: T.quiet, firstPingMs: T.firstPing, everyMs: T.every, failingMs: T.failing, baselineMs: T.baseline, recheckMs: T.recheck });
    const load = H.createLoadWatch({ now, xmxMB: H.toMB(info.memory), sustainMs: T.sustain });
    const w = { proc, info, hang, load, started, frozen: false, last: null, cpu: null, gcAt: 0, gcOffset: 0, tpsAt: 0, tpsFails: 0, evaluatedAt: now(), pinging: false };
    watched.set(k, w);

    // Every stop the app makes is a line on stdin; so is an owner typing "stop" in the console.
    markStops(proc);
    const take = (decoder) => (d) => {
      const text = partial + decoder.write(d);
      const lines = text.split(/\r?\n/);
      partial = lines.pop();
      if (!lines.length) return;
      for (const line of lines) {
        tail.push(line);
        if (!hang.isReady && H.READY.test(line)) hang.ready();
        if (load.line(line)) w.lastBehind = now();
      }
      if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
      if (hang.output() === 'recovered') { w.frozen = false; emit(dir, 'recovered'); }
    };
    proc.stdout?.on('data', take(new StringDecoder('utf8')));
    proc.stderr?.on('data', take(new StringDecoder('utf8')));
    const timer = setInterval(() => step(w).catch((err) => log(`health: ${err.message}`)), T.tick);
    timer.unref?.();
    proc.once('close', (code) => {
      clearInterval(timer);
      if (watched.get(k) === w) watched.delete(k);
      if (partial) tail.push(partial);
      ended(w, { code, expected: !!proc.stopAsked || quitting || H.askedToStop(tail.slice(-40)), tail });
    });
  }

  async function step(w) {
    const { info, hang, load } = w;
    if (w.proc.stopAsked) return;
    const settings = settingsOf(info.dir);
    if (settings.hang && hang.pingDue() && !w.pinging) {
      w.pinging = true;
      const r = await pingServer(info.host || '127.0.0.1', info.port, T.pingTimeout).catch(() => ({ online: false }));
      w.pinging = false;
      if (w.proc.stopAsked) return;
      if (hang.pinged(!!r.online) === 'recovered') { w.frozen = false; emit(info.dir, 'recovered'); }
    }
    if (settings.hang && hang.check() === 'frozen') {
      w.frozen = true;
      const restart = settings.autoRestart ? policy.crashed(keyOf(info.dir), { cause: 'frozen', auto: true }) : null;
      log(`health: ${info.dir} has printed nothing and answered no ping for ${Math.round(hang.quietFor() / 1000)} s`);
      emit(info.dir, 'frozen', { quietMs: hang.quietFor(), restart });
    }
    if (!settings.overload || !hang.isReady) return;
    if (info.paper && info.query && now() - w.tpsAt >= T.tps && w.tpsFails < 2) {
      w.tpsAt = now();
      info.query('tps', (msg) => { const m = H.TPS.exec(String(msg)); return m ? Number(m[1]) : undefined; }, 4000)
        .then((v) => { load.tps(v); w.tpsFails = 0; }, () => { w.tpsFails++; });
    }
    if (now() - w.evaluatedAt < T.evaluate) return;
    w.evaluatedAt = now();
    readGc(w);
    const r = load.evaluate();
    const extra = describe(info.dir);
    const tips = r.state === 'fine' ? [] : H.suggestions({ reasons: r.reasons, memory: info.memory, ramMB, gameHere: gameHere(info.dir), ...extra });
    w.last = { state: r.state, numbers: { ...r.numbers, workingSetMB: w.cpu?.wsMB ?? null }, reasons: r.reasons, suggestions: tips, at: now() };
    emit(info.dir, 'load', { ...w.last, notify: r.notify });
  }

  function readGc(w) {
    const file = path.join(w.info.dir, GC_FILE);
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < w.gcOffset) w.gcOffset = 0; // rotated
    if (size === w.gcOffset) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const len = Math.min(size - w.gcOffset, 1 << 20);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      // A line the JVM is still writing is read with the next part.
      const end = buf.lastIndexOf(10) + 1;
      w.gcOffset = size - len + end;
      w.load.gc(H.parseGc(buf.subarray(0, end).toString('utf8')));
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  function ended(w, { code, expected, tail }) {
    const { dir } = w.info;
    const k = keyOf(dir);
    if (expected) { emit(dir, 'stopped', { code }); return; }
    const ev = H.readEvidence(dir, { pid: w.proc.pid, since: w.started, tail });
    const report = {
      ...H.classify(ev, { memory: w.info.memory, ramMB, port: w.info.port, java: w.info.java, gameHere: gameHere(dir) }),
      code, at: now(), beforeReady: !w.hang.isReady, whileAway: false,
    };
    report.restart = policy.crashed(k, { cause: report.cause, beforeReady: report.beforeReady, auto: settingsOf(dir).autoRestart });
    reports.set(k, report);
    log(`health: ${dir} ended unexpectedly (exit ${code}): ${report.cause}${report.restart.restart ? `, restarting in ${report.restart.delayMs} ms` : ''}`);
    emit(dir, 'crashed', { report });
  }

  // A marker whose process is gone, found when the app looks at the server again: it ended while no Nano Studio
  // watched it. A stop an operator asked for is no news.
  function foundGone(dir, marker) {
    const ev = H.readEvidence(dir, { pid: marker.pid, since: marker.started });
    const lines = (ev.log?.text || '').split(/\r?\n/);
    if (H.askedToStop(lines.slice(-60))) return;
    const desc = (() => { try { return readServer(dir); } catch { return {}; } })();
    const report = { ...H.classify(ev, { memory: desc?.memory, ramMB, java: desc?.java, gameHere: gameHere(dir) }), code: null, at: now(),
      startedAt: marker.started, beforeReady: false, whileAway: true, restart: { restart: false, count: 0, why: 'away' } };
    reports.set(keyOf(dir), report);
    log(`health: ${dir} was found ended (process ${marker.pid} gone): ${report.cause}`);
    emit(dir, 'crashed', { report });
  }

  // CPU and memory of every watched process, one PowerShell for all of them while any is watched for lag.
  let cpuBusy = false;
  const cpuTimer = setInterval(() => {
    const list = [...watched.values()].filter((w) => w.proc.pid && w.hang.isReady && settingsOf(w.info.dir).overload);
    if (!list.length || cpuBusy) return;
    cpuBusy = true;
    const script = `Get-Process -Id ${list.map((w) => w.proc.pid).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, out) => {
      cpuBusy = false;
      if (err) return;
      const t = now();
      for (const line of String(out).trim().split(/\r?\n/)) {
        const [pid, cpu, ws] = line.trim().split(/\s+/).map(Number);
        const w = list.find((x) => x.proc.pid === pid);
        if (!w || !Number.isFinite(cpu)) continue;
        if (w.cpu) w.load.cpu(Math.round(((cpu - w.cpu.s) / ((t - w.cpu.at) / 1000) / os.cpus().length) * 100));
        w.cpu = { s: cpu, at: t, wsMB: Math.round(ws / H.MB) };
      }
    });
  }, T.cpu);
  cpuTimer.unref?.();

  return {
    prepare, watch, foundGone, settingsOf, setSettings,
    quitting() { quitting = true; },
    dismiss(dir) { reports.delete(keyOf(dir)); },
    // What the card shows after a reload: the last unexpected end, a freeze, the load.
    of(dir) {
      const k = keyOf(dir);
      const w = watched.get(k);
      return { report: reports.get(k) || null, frozen: !!w?.frozen, load: w?.last || null, crashes: policy.count(k), settings: settingsOf(dir) };
    },
    close() { clearInterval(cpuTimer); },
  };
}

module.exports = { createHealthMonitor, markStops, GC_LOG_ARG, DEFAULTS };
