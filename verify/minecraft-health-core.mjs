// Craft's crash, freeze and overload handling in plain Node: main/minecraft/health.js (what the evidence says, the
// restart policy, the freeze clock, the overload episodes, the suggestions) on samples in the formats the real servers
// and loaders print, and main/features/minecraft.js through its IPC handlers against a stand-in server process
// (verify/fixtures/craft-health/stand-in-server.cjs): a stop the app asked for against one nobody asked for, the cause
// read from what the process printed and wrote, the GC log option, an end found at the next start. No Minecraft, no
// window, no network beyond loopback. Sample formats: see the comment at the top of health.js for where each was read.
// Usage: node verify/minecraft-health-core.mjs
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
let failed = 0;
const check = (ok, label) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const work = mkdtempSync(path.join(tmpdir(), 'pyide-mchealth-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

// A clock the tests move by hand.
const clock = (start = 1_000_000) => { let t = start; const now = () => t; now.go = (ms) => { t += ms; }; return now; };

const H = require('../main/minecraft/health.js');
const P = '[12:00:01] [Server thread/INFO]: ';
const PW = '[12:00:01] [Server thread/WARN]: ';
const PE = '[12:00:01] [Server thread/ERROR]: ';
const MAIN = '[12:00:01] [main/ERROR]: ';
// The oshi stack Paper 26.3 logs at every start on Korean Windows (from a real latest.log): never a cause.
const OSHI = ['[08:18:09] [CrashReport preload thread/ERROR]: [oshi.driver.windows.registry.HkeyPerformanceDataUtil] Unable to locate English counter names in registry Perflib 009. Counters may need to be rebuilt: ',
  'com.sun.jna.platform.win32.Win32Exception: 매개 변수가 틀립니다.', '\tat net.minecraft.SystemReport.ignoreErrors(SystemReport.java:120) ~[paper-26.3.jar:26.3-235-bb10cf0]'];
const classify = (tail, extra = {}, ctx = {}) => H.classify({ tail, log: null, crash: null, hsErr: null, ...extra }, { memory: '2G', ramMB: 16384, port: 25565, java: 21, ...ctx });

try {
  // ---------- causes ----------
  let r = classify([...OSHI, `${PW}You need to agree to the EULA in order to run the server. Go to eula.txt for more info.`]);
  check(r.cause === 'eula' && r.lines.length === 1 && !r.lines.some((l) => /oshi/.test(l)), `the EULA line is the EULA cause, the oshi noise is not evidence (${S(r)})`);
  r = classify([`${PW}**** FAILED TO BIND TO PORT!`, `${PW}The exception was: io.netty.channel.unix.Errors$NativeIoException: bind(..) failed: Address already in use`, `${PW}Perhaps a server is already running on that port?`]);
  check(r.cause === 'port' && r.facts.port === 25565, `FAILED TO BIND TO PORT is the port in use, with the port (${S(r.facts)})`);
  r = classify([`${MAIN}Incompatible mods found!`, 'net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!',
    'A potential solution has been determined, this may resolve your problem:', '\t - Install fabric-api, version 0.92.0 or later.', 'More details:',
    "\t - Mod 'Sodium' (sodium) 0.5.8+mc1.20.1 requires version 0.92.0 or later of mod 'Fabric API' (fabric-api), which is missing!",
    "\t - Mod 'Lithium' (lithium) 0.11.2 requires version 1.20.2 or later of mod 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!"]);
  check(r.cause === 'dependency' && r.facts.items.length === 2 && r.facts.items[0].mod === "Mod 'Sodium' (sodium) 0.5.8+mc1.20.1" && /fabric-api/.test(r.facts.items[0].needs)
    && r.facts.items[0].found === null && r.facts.items[1].found === '1.20.1' && r.facts.gameVersion === true,
  `Fabric's English lines name each mod, what it wants and what is there (${S(r.facts)})`);
  r = classify([`${MAIN}호환되지 않는 모드가 있습니다!`, "\t - Mod 'Sodium' (sodium)(0.5.8 버전)은 Mod 'Fabric API' (fabric-api)(0.92.0 이상)이 필요하지만, 해당 모드가 빠져 있습니다!"]);
  check(r.cause === 'dependency' && /Sodium/.test(r.facts.items[0]?.mod) && /fabric-api/.test(r.facts.items[0]?.needs) && r.facts.items[0].version === '0.92.0 이상',
    `Fabric's Korean lines (a Korean Windows JVM) are read too (${S(r.facts)})`);
  r = classify(['[12:00:01] [main/ERROR] [ne.mi.fm.lo.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:',
    "\tMod ID: 'architectury', Requested by: 'rei', Expected range: '[9.1.12,)', Actual version: '[MISSING]'",
    "\tMod ID: 'minecraft', Requested by: 'create', Expected range: '[1.20.4,1.21)', Actual version: '1.20.1'"]);
  check(r.cause === 'dependency' && r.facts.items[0].mod === 'rei' && r.facts.items[0].needs === 'architectury' && r.facts.items[0].found === null
    && r.facts.items[1].found === '1.20.1' && r.facts.gameVersion, `Forge's dependency lines name the mod and what it wants (${S(r.facts)})`);
  r = classify(['Error: LinkageError occurred while loading main class io.papermc.paperclip.Main',
    '\tjava.lang.UnsupportedClassVersionError: io/papermc/paperclip/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0']);
  check(r.cause === 'java' && r.facts.needs === 25 && r.facts.has === 21, `a class file version the JVM cannot read is the wrong Java, with both versions (${S(r.facts)})`);
  r = classify(["\t - Mod 'Create' (create) 6.0.0 requires version 21 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 17!"]);
  check(r.cause === 'java', `Fabric naming java as the missing dependency is the wrong Java, not a mod (${r.cause})`);
  r = classify([`${PE}Encountered an unexpected exception`, 'java.lang.OutOfMemoryError: Java heap space', '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3540)']);
  check(r.cause === 'memory' && r.facts.memory === '2G' && r.facts.suggested === '4G' && r.facts.ramMB === 16384, `a heap OutOfMemoryError is memory, with the setting, the PC and a step up (${S(r.facts)})`);
  r = classify(['java.lang.OutOfMemoryError: Java heap space'], {}, { memory: '8G', ramMB: 12288 });
  check(r.cause === 'memory' && r.facts.suggested === null, `with no room left on the PC, no larger memory is suggested (${S(r.facts)})`);
  r = classify(['java.lang.OutOfMemoryError: Java heap space'], {}, { memory: '4G', ramMB: 16384, gameHere: true });
  check(r.facts.suggested === '6G', `the game played on the same PC keeps 4 GB of its own (${S(r.facts)})`);
  r = classify([], { hsErr: { file: 'C:\\s\\hs_err_pid42.log', text: '#\n# There is insufficient memory for the Java Runtime Environment to continue.\n# Native memory allocation (malloc) failed to allocate 1048576 bytes.\n' } });
  check(r.cause === 'pcMemory' && r.files.hsErr === 'C:\\s\\hs_err_pid42.log', `hs_err's insufficient memory is the PC out of memory, not -Xmx, and names the file (${S(r)})`);
  r = classify(['Error occurred during initialization of VM', 'Could not reserve enough space for 16777216KB object heap'], {}, { memory: '16G', ramMB: 16384 });
  check(r.cause === 'memoryTooHigh' && r.facts.suggested === '12G', `a heap the JVM cannot reserve is memory set too high, with a step down (${S(r.facts)})`);
  r = classify([`${PE}Failed to load world data. World files may be corrupted. Shutting down.`]);
  check(r.cause === 'world', 'a world the server cannot load is a damaged world');
  r = classify([`${PE}A single server tick took 60.00 seconds (should be max 0.05)`, `${PE}Considering it to be crashed, server will forcibly shutdown.`]);
  check(r.cause === 'watchdog' && r.facts.seconds === 60, `vanilla's watchdog is the watchdog, with the tick's seconds (${S(r.facts)})`);
  r = classify(['[12:00:01] [Paper Watchdog Thread/ERROR]: ------------------------------', '[12:00:01] [Paper Watchdog Thread/ERROR]: The server has stopped responding! This is (probably) not a Paper bug.']);
  check(r.cause === 'watchdog', "Paper's watchdog is the watchdog");
  r = classify(['[12:00:01] [ServerMain/ERROR]: Failed to start the minecraft server', 'java.lang.IllegalArgumentException: Invalid level-type'], {});
  check(r.cause === 'startup' && r.lines.some((l) => /IllegalArgumentException/.test(l)), `"Failed to start the minecraft server" is a startup failure with the exception after it (${S(r.lines)})`);
  r = classify([...OSHI, `${P}Done (3.2s)! For help, type "help"`, `${PE}Something odd happened`, 'java.lang.IllegalStateException: odd']);
  check(r.cause === 'unknown' && r.lines.some((l) => /IllegalStateException/.test(l)) && !r.lines.some((l) => /oshi|Win32Exception/.test(l)),
    `anything else is unknown, with its last error lines and none of the noise (${S(r.lines)})`);
  r = classify([], { crash: { file: 'C:\\s\\crash-reports\\crash-2026-11-10_12.00.00-server.txt', text: '---- Minecraft Crash Report ----\nDescription: Exception in server tick loop\n\njava.lang.NullPointerException: boom\n' } });
  check(r.cause === 'unknown' && r.lines[0] === 'Description: Exception in server tick loop' && /NullPointerException/.test(r.lines[1]) && /crash-2026/.test(r.files.crash),
    `an unknown crash shows the crash report's description and exception, and its file (${S(r)})`);

  // ---------- evidence of this run only ----------
  const ev = path.join(work, 'ev');
  write(path.join(ev, 'crash-reports', 'crash-old-server.txt'), 'Description: old\n');
  write(path.join(ev, 'crash-reports', 'crash-new-server.txt'), 'Description: Exception in server tick loop\n');
  const old = (Date.now() - 3600_000) / 1000;
  utimesSync(path.join(ev, 'crash-reports', 'crash-old-server.txt'), old, old);
  write(path.join(ev, 'logs', 'latest.log'), 'x\n');
  utimesSync(path.join(ev, 'logs', 'latest.log'), old, old);
  write(path.join(ev, 'hs_err_pid77.log'), '# There is insufficient memory for the Java Runtime Environment to continue.\n');
  const got = H.readEvidence(ev, { pid: 77, since: Date.now() - 60_000 });
  check(/crash-new/.test(got.crash?.file || '') && got.log === null && /hs_err_pid77/.test(got.hsErr?.file || ''),
    `only this run's files are evidence: the newer crash report, not last hour's log, the hs_err of this pid (${S({ crash: got.crash?.file, log: got.log, hs: got.hsErr?.file })})`);

  // ---------- a stop the server was asked for ----------
  check(H.askedToStop([`${P}System chat: Stopping the server`, `${P}Stopping server`]), "26.x's console stop feedback counts as asked (seen in a real Paper 26.3 log)");
  check(H.askedToStop([`${P}[Steve: Stopping the server]`]), "an operator's /stop in the game counts as asked");
  check(!H.askedToStop([`${P}<Bob> Stopping the server`, `${P}Stopping server`]), 'a player chatting the words, and the "Stopping server" every end prints, do not');

  // ---------- automatic restart ----------
  {
    const now = clock();
    const p = H.createRestartPolicy({ now });
    const a = p.crashed('a', { cause: 'unknown', auto: true });
    now.go(60_000);
    const b = p.crashed('a', { cause: 'watchdog', auto: true });
    now.go(60_000);
    const c = p.crashed('a', { cause: 'unknown', auto: true });
    check(a.restart && a.delayMs === 10000 && b.restart && b.delayMs === 30000 && !c.restart && c.why === 'loop' && c.count === 3,
      `two crashes restart after 10 s then 30 s, the third within ten minutes stops the loop (${S([a, b, c])})`);
    now.go(10 * 60_000);
    const d = p.crashed('a', { cause: 'unknown', auto: true });
    check(d.restart && d.count === 1 && d.delayMs === 10000, `ten quiet minutes later the count starts again (${S(d)})`);
    const never = [...H.NEVER].map((cause) => p.crashed(`n-${cause}`, { cause, auto: true }));
    check(never.every((x) => !x.restart && x.why === 'cause'), `never after ${[...H.NEVER].join(', ')}: they come back at every start (${S(never.map((x) => x.why))})`);
    const early = p.crashed('e', { cause: 'unknown', beforeReady: true, auto: true });
    const off = p.crashed('o', { cause: 'unknown', auto: false });
    check(!early.restart && early.why === 'startup' && !off.restart && off.why === 'off' && off.count === 1, `a crash before Done never restarts, and with the setting off nothing does but it is counted (${S([early, off])})`);
  }

  // ---------- the freeze clock ----------
  {
    const now = clock();
    const h = H.createHangWatch({ now });
    now.go(10 * 60_000);
    check(!h.pingDue() && h.check() === null, 'nothing is counted before the server said Done, however long it is silent (world generation)');
    h.ready();
    now.go(5000);
    check(h.pingDue(), 'once Done, a first ping checks the server can be seen at all');
    h.pinged(true);
    now.go(20_000);
    check(!h.pingDue(), 'a server that just printed is not pinged');
    now.go(40_000);
    check(h.pingDue(), 'after 30 s of silence, and a minute after its last answer, it is');
    h.pinged(true);
    now.go(30_000);
    check(!h.pingDue() && h.check() === null, 'a quiet server that answered is idle, not frozen, and is not pinged again at once');
    now.go(30_000);
    check(h.pingDue(), 'it is pinged again a minute later');
    for (let i = 0; i < 6; i++) { h.pinged(false); now.go(15_000); }
    check(h.check() === 'frozen' && h.frozen, `silent and unanswered for 90 s of pings after more silence: frozen (quiet ${h.quietFor() / 1000} s)`);
    check(h.check() === null, 'and said once');
    check(h.output() === 'recovered' && !h.frozen, 'a line of output ends the freeze');

    const n2 = clock();
    const h2 = H.createHangWatch({ now: n2 });
    h2.ready();
    n2.go(5000);
    h2.pinged(false);
    n2.go(30 * 60_000);
    check(!h2.pingDue() && h2.check() === null, 'a server that never answered the first ping (a server-ip elsewhere) is not judged at all');

    const n3 = clock();
    const h3 = H.createHangWatch({ now: n3 });
    h3.ready();
    n3.go(5000);
    h3.pinged(true);
    n3.go(30_000);
    h3.pinged(false);
    n3.go(100_000);
    h3.pinged(false);
    check(h3.check() === null, 'two missed pings are not enough');
    n3.go(15_000);
    h3.pinged(false);
    check(h3.check() === 'frozen', 'three, over more than 90 s, with 2 minutes of silence, are');
  }

  // ---------- overload episodes ----------
  {
    const now = clock();
    const w = H.createLoadWatch({ now, xmxMB: 2048 });
    const behind = (ms) => w.line(`${PW}Can't keep up! Is the server overloaded? Running ${ms}ms or ${ms / 50} ticks behind`);
    behind(2500);
    let e = w.evaluate();
    check(e.state === 'fine' && !e.notify, 'one spike (a player exploring) is fine');
    behind(3000);
    e = w.evaluate();
    check(e.state === 'lagging' && !e.notify && e.numbers.behindCount === 2 && e.numbers.behindMaxMs === 3000, `two in five minutes: lagging, no notification (${S(e.numbers)})`);
    for (let i = 0; i < 5; i++) { now.go(15_000); behind(2600); }
    e = w.evaluate();
    check(e.state === 'overloaded' && !e.notify, 'six or more: overloaded, but not yet said');
    now.go(30_000); behind(2600);
    e = w.evaluate();
    check(e.state === 'overloaded' && !e.notify, 'still not said 30 s later');
    now.go(31_000); behind(2600);
    e = w.evaluate();
    check(e.notify, 'said once it has lasted a minute');
    now.go(20_000); behind(2600);
    check(!w.evaluate().notify, 'and only once in the episode');
    now.go(6 * 60_000);
    check(w.evaluate().state === 'fine', 'five minutes without a line: fine');
    now.go(5 * 60_000);
    w.evaluate();
    for (let i = 0; i < 7; i++) { now.go(15_000); behind(2600); }
    w.evaluate();
    now.go(61_000); behind(2600);
    check(w.evaluate().notify, 'after five calm minutes a new episode is said again');

    const n2 = clock();
    const m = H.createLoadWatch({ now: n2, xmxMB: 2048 });
    const real = H.parseGc('[0.011s] Using G1\n[0.053s] GC(0) Pause Young (Concurrent Start) (G1 Humongous Allocation) 28M->17M(64M) 1.204ms\n[0.066s] GC(13) Pause Full (G1 Compaction Pause) 61M->61M(64M) 2.671ms\n');
    check(real.length === 2 && real[0].afterMB === 17 && real[1].full && real[1].pauseMs === 2.671, `the JDK's own -Xlog:gc lines are read (${S(real)})`);
    m.gc([{ full: false, afterMB: 1200, pauseMs: 40 }]);
    check(m.evaluate().state === 'fine', 'a heap at 60% after GC is fine');
    m.gc([{ full: true, afterMB: 1900, pauseMs: 2400 }]);
    e = m.evaluate();
    check(e.state === 'overloaded' && e.reasons.memory && e.numbers.heapPct === 93 && e.numbers.fullGcs === 1, `93% left after a full GC: overloaded for memory (${S(e.numbers)})`);
    m.tps(14.2);
    check(m.evaluate().numbers.tps === 14.2, "Paper's tps is among the numbers");
  }

  // ---------- suggestions ----------
  {
    let s = H.suggestions({ reasons: { memory: true, ticks: true }, memory: '2G', ramMB: 16384 });
    check(S(s) === S([{ id: 'memory', from: '2G', to: '4G' }]), `memory pressure: raise memory, nothing about distances (${S(s)})`);
    s = H.suggestions({ reasons: { memory: true }, memory: '12G', ramMB: 16384 });
    check(s[0]?.id === 'noRoom', 'no room on the PC: said so instead of a number');
    s = H.suggestions({ reasons: { ticks: true }, memory: '4G', ramMB: 16384, view: 12, sim: 10 });
    check(S(s) === S([{ id: 'distance', view: { from: 12, to: 8 }, sim: { from: 10, to: 6 } }]), `ticks behind with memory fine: lower view and simulation distance, from and to (${S(s)})`);
    s = H.suggestions({ reasons: { ticks: true }, memory: '4G', ramMB: 16384, view: 6, sim: 4 });
    check(!s.length, 'distances already low: nothing invented');
    s = H.suggestions({ reasons: { ticks: true }, memory: '4G', ramMB: 16384, view: 6, sim: 4, paper: true, antiXray: 'strong' });
    check(s[0]?.id === 'antiXray', "on Paper with Strong anti-xray, the anti-xray setting Craft manages is pointed at");
  }

  // ---------- through main/features/minecraft.js, against the stand-in process ----------
  process.env.PYIDE_TRUST_ALL = '1';
  process.env.PYIDE_INSTALL_ROOT = path.join(work, 'install-root');
  process.env.PYIDE_MC_HEALTH_MS = S({ tick: 50, quiet: 1200, firstPing: 200, every: 150, recheck: 150, failing: 600, baseline: 100, pingTimeout: 300, evaluate: 200, sustain: 400, cpu: 3_600_000, tps: 100, delays: [200, 400] });
  const javaHome = path.join(work, 'java');
  write(path.join(javaHome, 'bin', 'java.exe'), 'never run');
  process.env.PYIDE_MC_JAVA = javaHome;
  const load = Module._load;
  const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => work, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : class {}) });
  const holders = [];
  const appInstance = () => {
    delete require.cache[require.resolve('../main/features/minecraft.js')];
    Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
    const f = require('../main/features/minecraft.js');
    Module._load = load;
    const hs = new Map();
    const procs = new Map();
    const events = [];
    let n = 0;
    const startProcess = (cmd, args, opts) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
      // As main.js does: the players session reads the output through its filter (its queries need it).
      child.stdout.on('data', (d) => opts.filter?.(String(d), 'out'));
      holders.push(child);
      procs.set(++n, child);
      return n;
    };
    f.register({ ipcMain: { handle: (h, fn) => hs.set(h, fn), on() {} }, send: (ch, v) => { if (ch === 'minecraft:health') events.push(v); }, startProcess, procs, diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
    const call = (name, ...args) => hs.get(name)({}, ...args);
    return { call, events, procs };
  };
  const app = appInstance();
  const proj = path.join(work, 'project');
  const standIn = path.resolve('verify/fixtures/craft-health/stand-in-server.cjs');
  const server = (name, cfg, desc = {}) => {
    const dir = path.join(proj, 'servers', name);
    write(path.join(dir, 'pyide-server.json'), S({ kind: 'fabric', mc: '26.3', loader: '0.17.0', java: 21, memory: '2G', launch: { jar: 'server.jar' }, ...desc }));
    write(path.join(dir, 'server.properties'), `server-port=${cfg.port || 25700}\nview-distance=12\nsimulation-distance=10\n`);
    write(path.join(dir, 'stand-in.json'), S(cfg));
    return dir;
  };
  const start = async (dir) => {
    const spec = await app.call('minecraft:launch', proj, dir, 'job');
    const id = await app.call('minecraft:start', proj, { ...spec, cmd: process.execPath, args: [standIn] });
    return { spec, id, proc: app.procs.get(id) };
  };
  const exited = (proc, ms = 10000) => new Promise((r) => { if (proc.exitCode !== null) r(true); else { proc.once('exit', () => r(true)); setTimeout(r, ms, false); } });
  const eventFor = async (dir, kind, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const e = app.events.find((x) => x.dir === dir && x.event === kind);
      if (e) return e;
    }
    return null;
  };

  // The GC log option: Java 9 and later only, and not over the user's own -Xlog.
  const gcDir = server('gc', {});
  const spec21 = await app.call('minecraft:launch', proj, gcDir, 'job');
  const at = spec21.args.indexOf('-Xlog:gc:file=.nano/gc.log:uptime:filecount=2,filesize=2m');
  check(at > 0 && spec21.args[at + 1] === '-Xmx2G', `a Java 21 server logs its GC to .nano/gc.log, just before -Xmx (${spec21.args.slice(Math.max(0, at - 1), at + 2).join(' ')})`);
  write(path.join(gcDir, 'pyide-server.json'), S({ kind: 'paper', mc: '1.16.5', java: 8, memory: '1G', launch: { jar: 'server.jar' } }));
  check(!(await app.call('minecraft:launch', proj, gcDir, 'job')).args.some((a) => /^-Xlog/.test(a)), 'a Java 8 server, which refuses -Xlog, gets none');
  write(path.join(gcDir, 'pyide-server.json'), S({ kind: 'paper', mc: '26.3', java: 25, memory: '1G', launch: { jar: 'server.jar' }, jvmArgs: ['-Xlog:gc*:file=mine.log'] }));
  check((await app.call('minecraft:launch', proj, gcDir, 'job')).args.filter((a) => /^-Xlog/.test(a)).length === 1, "a server with its own -Xlog keeps only the user's");

  // Stop through stdin, as the card's Stop, the quit gate and an update all send it: expected. The stand-in says only
  // "Stopping server", which every end prints, so it is the stdin line that counts here.
  const calm = server('calm', { port: 25701 });
  const s1 = await start(calm);
  await eventFor(calm, 'started');
  await sleep(300);
  s1.proc.stdin.write('stop\n');
  await exited(s1.proc);
  const stopped = await eventFor(calm, 'stopped');
  check(!!stopped && !app.events.some((e) => e.dir === calm && e.event === 'crashed'), `"stop" sent to the server is an expected end: no crash (${S(stopped)})`);

  // Exit 0 without being asked is a crash too.
  const zero = server('zero', { port: 25702, exitMs: 400, code: 0 });
  const s2 = await start(zero);
  await exited(s2.proc);
  const z = await eventFor(zero, 'crashed');
  check(z?.report.cause === 'unknown' && z.report.code === 0 && !z.report.beforeReady && z.report.restart.why === 'off',
    `an exit with code 0 nobody asked for is a crash, cause unknown, no restart while the setting is off (${S(z?.report)})`);
  const listed = (await app.call('minecraft:servers', proj)).find((s) => s.name === 'zero');
  check(listed?.health?.report?.cause === 'unknown', 'the server list carries the report for a window that reloads');

  // OutOfMemoryError printed by the process, then exit 1: memory, with the setting and a step up.
  const oom = server('oom', { port: 25703, exitMs: 400, code: 1, oom: true });
  const s3 = await start(oom);
  await exited(s3.proc);
  const o = await eventFor(oom, 'crashed');
  check(o?.report.cause === 'memory' && o.report.facts.memory === '2G' && o.report.lines.some((l) => /OutOfMemoryError: Java heap space/.test(l)),
    `the console's OutOfMemoryError says memory (${S(o?.report)})`);

  // A crash report written by the run: its description and its file.
  const cr = server('report', { port: 25704, exitMs: 400, code: 1, crashReport: true });
  const s4 = await start(cr);
  await exited(s4.proc);
  const c = await eventFor(cr, 'crashed');
  check(c?.report.cause === 'unknown' && /crash-reports[\\/]crash-/.test(c.report.files.crash || '') && c.report.lines.includes('Description: Exception in server tick loop'),
    `the run's crash report is named and its description shown, and the cause is said to be unknown (${S(c?.report)})`);

  // An operator's /stop in the game: expected.
  const op = server('op', { port: 25705, opStopMs: 400 });
  const s5 = await start(op);
  await exited(s5.proc);
  check(!!(await eventFor(op, 'stopped')) && !app.events.some((e) => e.dir === op && e.event === 'crashed'), "an operator's /stop in the game is an expected end");

  // Automatic restart on: restart due after the policy's wait; a crash before Done is not restarted.
  const auto = server('auto', { port: 25706, exitMs: 400, code: 1 });
  await app.call('minecraft:setHealth', proj, auto, { autoRestart: true });
  const s6 = await start(auto);
  await exited(s6.proc);
  const a1 = await eventFor(auto, 'crashed');
  check(a1?.report.restart.restart === true && a1.report.restart.delayMs === 200 && a1.report.restart.count === 1, `with automatic restart on, a crash after Done asks for a restart after the first wait (${S(a1?.report.restart)})`);
  check(JSON.parse(readFileSync(path.join(auto, 'pyide-server.json'), 'utf8')).health?.autoRestart === true, 'the setting is kept in pyide-server.json');
  const early = server('early', { port: 25707, doneMs: 5000, exitMs: 200, code: 1 });
  await app.call('minecraft:setHealth', proj, early, { autoRestart: true });
  const s7 = await start(early);
  await exited(s7.proc);
  const e1 = await eventFor(early, 'crashed');
  check(e1?.report.beforeReady && e1.report.restart.restart === false && e1.report.restart.why === 'startup', `a crash before Done is not restarted: it would repeat (${S(e1?.report.restart)})`);

  // A server that goes silent and stops answering pings after Done: frozen, once; never killed here.
  const frozenDir = server('frozen', { port: 25708, freezeMs: 600 });
  const s8 = await start(frozenDir);
  const f = await eventFor(frozenDir, 'frozen', 15000);
  check(!!f && f.quietMs >= 1200 && s8.proc.exitCode === null && f.restart === null, `silent and unanswered after Done: reported frozen, the process left alone (${S(f)})`);
  s8.proc.kill();
  await exited(s8.proc);

  // Lag lines turn the state; the suggestion has the distances from server.properties.
  const lag = server('lag', { port: 25709, lag: 8, lagEveryMs: 60 });
  const s9 = await start(lag);
  let loadEv = null;
  for (const end = Date.now() + 10000; Date.now() < end && !loadEv; await sleep(50)) loadEv = app.events.find((x) => x.dir === lag && x.event === 'load' && x.state === 'overloaded');
  check(loadEv?.reasons.ticks && loadEv.numbers.behindCount === 8 && S(loadEv.suggestions[0]) === S({ id: 'distance', view: { from: 12, to: 8 }, sim: { from: 10, to: 6 } }),
    `"Can't keep up" lines turn the state to overloaded with the distances to lower (${S(loadEv && { numbers: loadEv.numbers, suggestions: loadEv.suggestions })})`);
  let told = null;
  for (const end = Date.now() + 5000; Date.now() < end && !told; await sleep(50)) told = app.events.find((x) => x.dir === lag && x.event === 'load' && x.notify);
  check(!!told && app.events.filter((x) => x.dir === lag && x.notify).length === 1, 'a sustained overload is said once');
  s9.proc.stdin.write('stop\n');
  await exited(s9.proc);

  // A server that hangs in its stop, with a tps query out when "stop" goes and automatic restart on. While it stops,
  // nothing but the stop is written to it (a query or a save command would make it print and re-arm the window's 60 s
  // of silence), no freeze is called though it is silent and unanswered, and the forced end (the window's, after the
  // silence) is a stop, not a crash: no restart is due, and the window's own message is the only one.
  const hungDir = server('hungstop', { port: 25712, hangStop: true, tps: 19.5, tpsDelayMs: 3000 }, { kind: 'paper', mc: '1.20.1', loader: null });
  await app.call('minecraft:setHealth', proj, hungDir, { autoRestart: true });
  const commandsOf = (dir) => (existsSync(path.join(dir, 'commands.log')) ? readFileSync(path.join(dir, 'commands.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const s10 = await start(hungDir);
  for (let i = 0; i < 200 && !commandsOf(hungDir).includes('tps'); i++) await sleep(25);
  const queryOut = commandsOf(hungDir).includes('tps');
  const mark = app.events.length;
  s10.proc.stdin.write('stop\n');
  await sleep(5000);
  const sinceStop = commandsOf(hungDir).slice(commandsOf(hungDir).indexOf('stop'));
  const during = app.events.slice(mark).filter((e) => e.dir === hungDir).map((e) => e.event);
  check(queryOut && S(sinceStop) === S(['stop']) && !during.includes('frozen') && s10.proc.exitCode === null,
    `while a server stops, with a health query out, it is sent nothing more and no freeze is called (query out: ${queryOut}; since "stop": ${S(sinceStop)}; events: ${S(during)})`);
  s10.proc.kill();
  await exited(s10.proc);
  const forced = await eventFor(hungDir, 'stopped');
  check(!!forced && !app.events.some((e) => e.dir === hungDir && ['crashed', 'frozen'].includes(e.event)) && !(await app.call('minecraft:healthOf', proj, hungDir)).report,
    `a stop that had to be forced, with automatic restart on, is a stop: no crash, no restart due (${S(app.events.filter((e) => e.dir === hungDir).map((e) => e.event))})`);

  // An end found at the next start: a marker whose process is gone, a crash report written since it started.
  const away = server('away', { port: 25710 });
  const since = Date.now();
  write(path.join(away, 'pyide-server.running'), S({ pid: 999_999_99, started: since, dir: away }));
  write(path.join(away, 'logs', 'latest.log'), `${P}Done (3.1s)! For help, type "help"\n${PE}A single server tick took 60.00 seconds (should be max 0.05)\n${PE}Considering it to be crashed, server will forcibly shutdown.\n`);
  const later = appInstance();
  await later.call('minecraft:servers', proj);
  const gone = later.events.find((e) => e.dir === away && e.event === 'crashed');
  check(gone?.report.whileAway && gone.report.cause === 'watchdog' && !existsSync(path.join(away, 'pyide-server.running')),
    `a marker whose process is gone at the next start reports how it ended while the app was not looking (${S(gone?.report)})`);
  const clean = server('clean', { port: 25711 });
  write(path.join(clean, 'pyide-server.running'), S({ pid: 999_999_98, started: Date.now(), dir: clean }));
  write(path.join(clean, 'logs', 'latest.log'), `${P}System chat: Stopping the server\n${P}Stopping server\n`);
  await later.call('minecraft:servers', proj);
  check(!later.events.some((e) => e.dir === clean && e.event === 'crashed'), 'one whose log says it was asked to stop is no news');
  for (const h of holders) { try { h.kill(); } catch {} }
} catch (err) {
  check(false, `suite error: ${err.stack}`);
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
