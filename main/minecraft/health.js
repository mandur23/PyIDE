// What a server's end, silence or lag says, from evidence only: the tail of its console, logs/latest.log, the newest
// crash-reports/*.txt and hs_err_pid<pid>.log. Pure functions and small state machines with an injectable clock; the
// process wiring is health-monitor.js.
//
// Message formats, and where each was checked (strings read from the class files' constant pools or seen in a run):
// - Paper 26.3 (paper-26.3.jar of a real server on this PC) and vanilla 26.3 (fabric-loom's extracted server jar):
//   "You need to agree to the EULA in order to run the server", "**** FAILED TO BIND TO PORT!", "Failed to start the
//   minecraft server", "Failed to load world data. World files may be corrupted. Shutting down.", "A single server tick
//   took {} seconds (should be max {})", "Considering it to be crashed, server will forcibly shutdown.", "Done ({})! For
//   help, type "help"", "Description: ", "This crash report has been saved to: {}". Vanilla only: "Can't keep up! Is the
//   server overloaded? Running {}ms or {} ticks behind" (Paper 26.3 has no such line). Paper only: "The server has
//   stopped responding! This is (probably) not a Paper bug." and the tps command's "TPS from last 1m, 5m, 15m: ".
//   A real Paper 26.3 log: "System chat: Stopping the server" then "Stopping server" for a stop asked of the server,
//   and an oshi "[CrashReport preload thread/ERROR]" stack at every start on Korean Windows, which is noise.
// - Fabric Loader 0.20.1 (Messages.properties and Messages_ko_KR.properties): "{0} {1} requires {3} of {2}, which is
//   missing!" and "..., but only the wrong version is present: {4}!", in English or, on Korean Windows, Korean.
// - Forge 1.20.1 fmlloader 47.4.28 (ModSorter): "Missing or unsupported mandatory dependencies:" and "\tMod ID: '%s',
//   Requested by: '%s', Expected range: '%s', Actual version: '%s'".
// - JDK 21 and 25, run here: "java.lang.OutOfMemoryError: Java heap space", "java.lang.UnsupportedClassVersionError: X
//   has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java
//   Runtime only recognizes class file versions up to 65.0", "Could not reserve enough space for ...KB object heap", the
//   -Xlog:gc line "[0.053s] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 28M->17M(64M) 1.204ms" and "Pause Full";
//   jvm.dll's "There is insufficient memory for the Java Runtime Environment to continue."
// Not checked against a real file (written from memory): NeoForge's dependency lines (read with Forge's pattern),
// Forge's "[MISSING]" for an absent mod, "java.net.BindException: Address already in use", Velocity's "Done (1.23s)!",
// "Exception reading .../level.dat" of old versions, and whether Paper's tps answer has a "System chat: " prefix on the
// console (the pattern takes it with or without).
const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
const LINE_PREFIX = /^\[[^\]]*\] \[[^\]]*\/(?:[A-Z]+)\]: (?:\[[^\]]*\] )?/;
const bare = (line) => line.replace(LINE_PREFIX, '');
// Logged at every start on Korean Windows by the crash report's preload (oshi cannot read the performance counters).
const NOISE = /CrashReport preload thread|oshi\.|Win32Exception|PerfCounterQuery|HkeyPerformanceDataUtil/;

// ---------- reading the evidence ----------
const tailOf = (file, bytes) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
};
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
// Files of this run only: a crash report from last week says nothing about today's end. A moment's slack, since the
// marker and the clock are read just after the spawn.
const SLACK_MS = 5000;
function readEvidence(dir, { pid, since = 0, tail = [] } = {}) {
  const fresh = (file) => mtime(file) >= since - SLACK_MS;
  const log = path.join(dir, 'logs', 'latest.log');
  const reports = path.join(dir, 'crash-reports');
  let crash = null;
  try {
    const newest = fs.readdirSync(reports).filter((n) => /\.txt$/i.test(n)).map((n) => path.join(reports, n)).filter(fresh)
      .sort((a, b) => mtime(b) - mtime(a))[0];
    if (newest) crash = { file: newest, text: tailOf(newest, 256 * 1024) || '' };
  } catch {}
  const hs = pid ? path.join(dir, `hs_err_pid${pid}.log`) : null;
  return {
    tail,
    log: fresh(log) ? { file: log, text: tailOf(log, 256 * 1024) || '' } : null,
    crash,
    hsErr: hs && fresh(hs) ? { file: hs, text: tailOf(hs, 64 * 1024) || '' } : null,
  };
}

// ---------- what a server's end says ----------
const FABRIC_EN = /^\s*-?\s*(.+?) requires (.+?) of (.+?), (which is missing|but only the wrong versions? (?:is|are) present: (.+?))!\s*$/;
const FABRIC_KO = /^\s*-?\s*(.+?)\(([^()]+?) 버전\)은 (.+?)\(([^()]+)\)이 필요하지만, (해당 모드가 빠져 있습니다|잘못된 버전\((.+?)\)이 있습니다)!\s*$/;
const FORGE = /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/;
const CLASS_VERSION = /UnsupportedClassVersionError: .*?\(class file version (\d+)(?:\.\d+)?\), this version of the Java Runtime only recognizes class file versions up to (\d+)/;
const HEAP_OOM = /java\.lang\.OutOfMemoryError: (Java heap space|GC overhead limit exceeded)/;
const OTHER_OOM = /java\.lang\.OutOfMemoryError(?:: (.+))?$|There is insufficient memory for the Java Runtime Environment to continue/;
const ERRORISH = /\/(?:ERROR|FATAL)\]|^\s*(?:Caused by: )?[\w.$]+(?:Exception|Error)(?::|$)|^Description: /;

// The lines of the evidence, newest source last; each source keeps its own order.
function linesOf(ev) {
  const split = (t) => (t || '').split(/\r?\n/).filter((l) => l.trim());
  return {
    crash: split(ev.crash?.text), hsErr: split(ev.hsErr?.text),
    console: (ev.tail || []).flatMap(split), log: split(ev.log?.text),
  };
}

// A requirement a mod loader named: {mod: who needs it, needs: what, version: which, found: what is there | null}.
function dependencies(all) {
  const out = [];
  const seen = new Set();
  const add = (d) => { const k = JSON.stringify(d); if (!seen.has(k)) { seen.add(k); out.push(d); } };
  for (const raw of all) {
    const line = bare(raw);
    let m = FABRIC_EN.exec(line);
    if (m) { add({ mod: m[1].trim(), needs: m[3].trim(), version: m[2].trim(), found: m[5]?.trim() || null }); continue; }
    m = FABRIC_KO.exec(line);
    if (m) { add({ mod: `${m[1].trim()} ${m[2].trim()}`, needs: m[3].trim(), version: m[4].trim(), found: m[6]?.trim() || null }); continue; }
    m = FORGE.exec(line);
    if (m) add({ mod: m[2], needs: m[1], version: m[3], found: /MISSING/i.test(m[4]) || !m[4] ? null : m[4] });
  }
  return out;
}
const isJavaDep = (d) => /\(java\)|^java$/i.test(d.needs);
const isGameDep = (d) => /\((minecraft|fabricloader|forge|neoforge)\)|^(minecraft|forge|neoforge)$/i.test(d.needs);

const javaOfClass = (v) => Number(v) - 44;

// evidence (readEvidence's, or the same shape) and what the server was given -> {cause, facts, lines, files}.
// cause: eula | port | java | dependency | memoryTooHigh | memory | pcMemory | world | watchdog | startup | unknown.
// lines: the evidence lines that say so (at most 8), shown to the owner as they are.
function classify(ev, { memory = '2G', ramMB = 0, port = null, java = null, gameHere = false } = {}) {
  const src = linesOf(ev);
  const all = [...src.crash, ...src.hsErr, ...src.console, ...src.log];
  const files = { ...(ev.crash && { crash: ev.crash.file }), ...(ev.hsErr && { hsErr: ev.hsErr.file }), ...(ev.log && { log: ev.log.file }) };
  const find = (re) => all.filter((l) => re.test(l) && !NOISE.test(l));
  const report = (cause, facts, lines) => ({ cause, facts, lines: [...new Set(lines)].slice(0, 8), files });

  let hit = find(/You need to agree to the EULA in order to run the server/);
  if (hit.length) return report('eula', {}, hit);
  hit = find(/\*\*\*\* FAILED TO BIND TO PORT!|Perhaps a server is already running on that port|BindException: Address already in use/);
  if (hit.length) return report('port', { port }, hit);
  hit = find(CLASS_VERSION);
  if (hit.length) {
    const m = CLASS_VERSION.exec(hit[0]);
    return report('java', { needs: javaOfClass(m[1]), has: javaOfClass(m[2]) || java }, hit);
  }
  const deps = dependencies(all);
  const javaDep = deps.find(isJavaDep);
  if (javaDep) return report('java', { needs: javaDep.version, has: java }, find(/requires|필요하지만/));
  if (deps.length) {
    return report('dependency', { items: deps.slice(0, 6), gameVersion: deps.some(isGameDep) },
      find(/requires .+ of |필요하지만|Mod ID: '|Missing or unsupported mandatory dependencies|Incompatible mods found|호환되지 않는 모드가 있습니다/));
  }
  hit = find(/Could not reserve enough space for .*object heap|Invalid maximum heap size/);
  if (hit.length) return report('memoryTooHigh', { memory, ramMB, suggested: memoryAdvice({ memory, ramMB, gameHere, lower: true }) }, hit);
  hit = find(HEAP_OOM);
  if (hit.length) return report('memory', { memory, ramMB, suggested: memoryAdvice({ memory, ramMB, gameHere }) }, hit);
  hit = find(OTHER_OOM);
  if (hit.length) return report('pcMemory', { memory, ramMB }, hit);
  hit = find(/Failed to load world data\. World files may be corrupted|Exception reading .*level\.dat/);
  if (hit.length) return report('world', {}, hit);
  hit = find(/A single server tick took [\d.,]+ seconds|Considering it to be crashed, server will forcibly shutdown|The server has stopped responding! This is \(probably\) not a Paper bug/);
  if (hit.length) {
    const s = /took ([\d.,]+) seconds/.exec(hit.join('\n'))?.[1];
    return report('watchdog', { seconds: s ? Number(s.replace(',', '.')) : null }, hit);
  }
  hit = find(/Failed to start the minecraft server/);
  if (hit.length) {
    const at = all.indexOf(hit[0]);
    const next = all.slice(at + 1, at + 4).filter((l) => ERRORISH.test(bare(l)));
    return report('startup', {}, [...hit, ...next]);
  }
  // Nothing known: the last error lines as they are, and the crash report's description if there is one.
  const desc = src.crash.filter((l) => /^Description: /.test(l) || /^[\w.$]+(?:Exception|Error)\b/.test(l)).slice(0, 2);
  const errors = [...src.console, ...src.log].filter((l) => ERRORISH.test(bare(l)) && !NOISE.test(l)).slice(-6);
  return report('unknown', {}, [...desc, ...errors]);
}

// A stop the server was asked for by someone in the game (an operator's /stop): the command's own feedback, with or
// without 26.x's "System chat: " and an operator's "[name: ...]".
const ASKED_STOP = /(?:^|: |\[[^\]]*: )Stopping the server\]?\s*$/;
const askedToStop = (lines) => lines.some((l) => ASKED_STOP.test(bare(l)));
// A server done starting: vanilla, Paper and the loaders print Done (12.345s)!, Velocity Done (1.23s)! (unverified).
const READY = /\bDone \(\d+(?:[.,]\d+)?s?\)!/;

// ---------- memory ----------
// No 3: a heap that ran out wants a real step.
const STEPS_GB = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
const toMB = (m) => { const x = /^(\d+)([MG])$/i.exec(m || ''); return x ? Number(x[1]) * (x[2].toUpperCase() === 'G' ? 1024 : 1) : 2048; };
// Room the server may take: the PC's memory less 3 GB for Windows, and 4 GB more when the game is played on this PC
// too (it has instances). -> the next step up (or down) as '4G', or null when there is none that fits.
function memoryAdvice({ memory, ramMB, gameHere = false, lower = false }) {
  if (!ramMB) return null;
  const cur = toMB(memory) / 1024;
  const room = ramMB / 1024 - 3 - (gameHere ? 4 : 0);
  const fits = STEPS_GB.filter((g) => g <= room);
  const pick = lower ? fits.filter((g) => g < cur).at(-1) : fits.find((g) => g > cur);
  return pick ? `${pick}G` : null;
}

// ---------- automatic restart ----------
// Causes that come back on every start: restarting only hides them behind a loop.
const NEVER = new Set(['eula', 'port', 'java', 'dependency', 'memoryTooHigh', 'memory', 'pcMemory', 'world', 'startup']);
// After a crash, with the server's setting on: the first two in ten minutes restart after a growing wait, the third
// stops the loop. A crash before the server finished starting would only repeat. -> {restart, count, delayMs?, why?}
// why: off | cause | startup | loop.
function createRestartPolicy({ now = Date.now, windowMs = 10 * 60000, limit = 3, delays = [10000, 30000] } = {}) {
  const crashes = new Map(); // server key -> times
  return {
    crashed(key, { cause, beforeReady = false, auto = false }) {
      const t = now();
      const list = (crashes.get(key) || []).filter((x) => t - x < windowMs);
      list.push(t);
      crashes.set(key, list);
      const count = list.length;
      if (!auto) return { restart: false, count, why: 'off' };
      if (NEVER.has(cause)) return { restart: false, count, why: 'cause' };
      if (beforeReady) return { restart: false, count, why: 'startup' };
      if (count >= limit) return { restart: false, count, why: 'loop' };
      return { restart: true, count, delayMs: delays[Math.min(count - 1, delays.length - 1)] };
    },
    count: (key) => (crashes.get(key) || []).filter((x) => now() - x < windowMs).length,
  };
}

// ---------- a server alive but frozen ----------
// The console silent for quietMs and no answer to the status ping for most of that time. Nothing counts before the
// server says it is done starting (world generation is silent and slow), and nothing at all when the first ping after
// that got no answer either: then this check cannot see the server (a server-ip it does not answer on), and says
// nothing rather than something false. A quiet server that answers is pinged again every recheckMs: a loopback status
// request, which vanilla and Paper do not log.
function createHangWatch({ now = Date.now, quietMs = 120000, firstPingMs = 30000, everyMs = 15000, recheckMs = 60000, failingMs = 90000, baselineMs = 5000 } = {}) {
  let readyAt = null;
  let baseline = null; // null: not asked yet; true: the server answers; false: it never did
  let lastOut = now();
  let lastPing = 0;
  let okAt = 0;
  let failingSince = null;
  let streak = 0;
  let frozen = false;
  return {
    output() {
      lastOut = now();
      failingSince = null;
      streak = 0;
      if (frozen) { frozen = false; return 'recovered'; }
      return null;
    },
    ready() { readyAt = now(); lastOut = readyAt; },
    get isReady() { return readyAt !== null; },
    get frozen() { return frozen; },
    get watching() { return baseline === true; },
    pingDue() {
      const t = now();
      if (readyAt === null || baseline === false || t - lastPing < everyMs) return false;
      if (baseline === null) return t - readyAt >= baselineMs;
      if (t - lastOut < firstPingMs) return false;
      return !(okAt > lastOut && t - okAt < recheckMs);
    },
    pinged(ok) {
      const t = now();
      lastPing = t;
      if (baseline === null) { baseline = ok; if (ok) okAt = t; return null; }
      if (ok) {
        okAt = t;
        failingSince = null;
        streak = 0;
        if (frozen) { frozen = false; return 'recovered'; }
        return null;
      }
      streak++;
      failingSince ??= t;
      return null;
    },
    check() {
      const t = now();
      if (frozen || baseline !== true || readyAt === null) return null;
      if (t - lastOut >= quietMs && streak >= 3 && failingSince !== null && t - failingSince >= failingMs) { frozen = true; return 'frozen'; }
      return null;
    },
    quietFor: () => now() - lastOut,
  };
}

// ---------- overload ----------
const BEHIND = /Can't keep up! Is the server overloaded\? Running (\d+)ms or (\d+) ticks behind/;
const TPS = /TPS from last 1m, 5m, 15m: \*?([\d.]+)/;
const GC_LINE = /^\[([\d.]+)s\].*?\bGC\(\d+\) Pause (Young|Full|Remark|Cleanup)\b.*?(\d+)M->(\d+)M\((\d+)M\) ([\d.]+)ms/;
// The JVM's own GC log (-Xlog:gc to a file): -> [{uptime, full, afterMB, committedMB, pauseMs}].
function parseGc(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = GC_LINE.exec(line);
    if (m) out.push({ uptime: Number(m[1]), full: m[2] === 'Full', afterMB: Number(m[4]), committedMB: Number(m[5]), pauseMs: Number(m[6]) });
  }
  return out;
}

// What the server reports about keeping up, in a window: vanilla's "Can't keep up" lines (at most one every 15 s, each
// at least 2 s behind), Paper's tps, the GC log, the process's CPU. -> evaluate(): {state: fine | lagging | overloaded,
// reasons: {ticks, memory}, numbers, notify}. notify is true once per episode: the state has been overloaded at two
// checks a minute or more apart, and an episode ends after five minutes of fine.
function createLoadWatch({ now = Date.now, xmxMB = 2048, windowMs = 5 * 60000, sustainMs = 60000, calmMs = 5 * 60000 } = {}) {
  let behind = [];
  let gcs = [];
  let tps = null;
  let cpu = null;
  let overloadedSince = null;
  let fineSince = now();
  let notified = false;
  const recent = (list, ms) => list.filter((x) => now() - x.at < ms);
  return {
    line(text) {
      const m = BEHIND.exec(text);
      if (m) { behind.push({ at: now(), ms: Number(m[1]), ticks: Number(m[2]) }); return true; }
      return false;
    },
    tps(v) { if (Number.isFinite(v)) tps = { at: now(), v }; },
    gc(list) { for (const g of list) gcs.push({ ...g, at: now() }); },
    cpu(pct) { if (Number.isFinite(pct)) cpu = { at: now(), v: pct }; },
    evaluate() {
      behind = recent(behind, windowMs);
      gcs = recent(gcs, windowMs);
      const minute = recent(gcs, 60000);
      const last = gcs.at(-1);
      const tpsNow = tps && now() - tps.at < 3 * 60000 ? tps.v : null;
      const numbers = {
        behindCount: behind.length, behindMaxMs: behind.reduce((m, b) => Math.max(m, b.ms), 0), tps: tpsNow,
        heapAfterMB: last?.afterMB ?? null, xmxMB, heapPct: last ? Math.round((last.afterMB / xmxMB) * 100) : null,
        gcPauseMs: Math.round(minute.reduce((s, g) => s + g.pauseMs, 0)), fullGcs: gcs.filter((g) => g.full).length,
        cpu: cpu && now() - cpu.at < 3 * 60000 ? cpu.v : null,
      };
      const memory = numbers.heapPct !== null && numbers.heapPct >= 85 && (numbers.fullGcs >= 1 || numbers.gcPauseMs >= 2000);
      const ticks = numbers.behindCount >= 2 || (tpsNow !== null && tpsNow < 18);
      const heavy = numbers.behindCount >= 6 || (tpsNow !== null && tpsNow < 15);
      const state = memory || (ticks && heavy) ? 'overloaded' : ticks || (numbers.heapPct ?? 0) >= 85 ? 'lagging' : 'fine';
      let notify = false;
      if (state === 'overloaded') {
        overloadedSince ??= now();
        if (!notified && now() - overloadedSince >= sustainMs) notify = notified = true;
      } else overloadedSince = null;
      if (state !== 'fine') fineSince = null;
      else {
        fineSince ??= now();
        if (now() - fineSince >= calmMs) notified = false;
      }
      return { state, reasons: { ticks, memory }, numbers, notify };
    },
  };
}

// One-click changes for an overload, ranked by what the evidence points to; each names what it changes, from and to, so
// it can be undone. Nothing here is applied by itself.
// -> [{id: 'memory', from, to} | {id: 'noRoom', memory} | {id: 'distance', view: {from, to}, sim: {from, to}} | {id: 'antiXray', level}]
function suggestions({ reasons, memory, ramMB, gameHere = false, view = 10, sim = 10, paper = false, antiXray = null }) {
  const out = [];
  if (reasons.memory) {
    const to = memoryAdvice({ memory, ramMB, gameHere });
    out.push(to ? { id: 'memory', from: memory, to } : { id: 'noRoom', memory });
  }
  if (reasons.ticks && !reasons.memory) {
    const v = Number(view) || 10;
    const s = Number(sim) || 10;
    const nv = Math.max(6, Math.min(v - 2, 8));
    const ns = Math.max(4, Math.min(s - 2, 6));
    if (nv < v || ns < s) out.push({ id: 'distance', view: { from: v, to: Math.min(nv, v) }, sim: { from: s, to: Math.min(ns, s) } });
    if (paper && ['strong', 'layers'].includes(antiXray)) out.push({ id: 'antiXray', level: antiXray });
  }
  return out;
}

module.exports = {
  readEvidence, classify, dependencies, askedToStop, READY, memoryAdvice, toMB, createRestartPolicy, NEVER,
  createHangWatch, createLoadWatch, parseGc, suggestions, BEHIND, TPS, MB,
};
