// A stand-in Minecraft server for the health tests (no Minecraft, no EULA, no network beyond loopback). It reads what to
// do from stand-in.json in its folder at each start, so a test changes its behaviour between starts:
//   port: answers the server list ping there (a status JSON) until it freezes
//   doneMs: when it prints Done (default 100)
//   exitMs, code: exits by itself then with that code, after printing `print` (lines) and writing what the flags say
//   oom: prints an OutOfMemoryError as a server thread would; crashReport: writes crash-reports/crash-...-server.txt
//   lag: how many "Can't keep up" lines, lagEveryMs apart, from doneMs on; gc: lines appended to .nano/gc.log after Done
//   freezeMs: from then on it prints nothing and answers no ping (the process stays)
//   opStopMs: an operator's /stop in the game, then a clean exit 0
//   onceOnly: the settings apply to the first start only; later starts just run (a crash that does not come back)
//   hangStop: "stop" is ignored, and from then on it prints nothing and answers no ping (a server hung in its stop)
//   tps (Paper's tps answer), tpsDelayMs: how long that answer takes
// Every line on stdin is appended to commands.log.
// Every start appends a line to starts.log. "stop" on stdin prints "Stopping server" (not the command's own feedback,
// so a test of the app's stop is not passed by the server's words) and exits 0 after saveMs.
const fs = require('fs');
const net = require('net');
const path = require('path');

const here = process.cwd();
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(here, 'stand-in.json'), 'utf8')); } catch {}
fs.appendFileSync(path.join(here, 'starts.log'), `${Date.now()}\n`);
const starts = fs.readFileSync(path.join(here, 'starts.log'), 'utf8').trim().split('\n').length;
if (cfg.onceOnly && starts > 1) cfg = { port: cfg.port, doneMs: cfg.doneMs };
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (text, level = 'INFO', thread = 'Server thread') => { if (!frozen) process.stdout.write(`[${stamp()}] [${thread}/${level}]: ${text}\n`); };
let frozen = false;

say('Starting minecraft server version 26.3', 'INFO', 'ServerMain');
fs.mkdirSync(path.join(here, 'logs'), { recursive: true });
fs.writeFileSync(path.join(here, 'logs', 'latest.log'), `[${stamp()}] [ServerMain/INFO]: Starting minecraft server version 26.3\n`);

if (cfg.port) {
  const varInt = (n) => { const out = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return Buffer.from(out); };
  net.createServer((s) => {
    s.on('error', () => {});
    s.once('data', () => {
      if (frozen) return; // holds the socket and says nothing, as a server whose threads all stand still
      const json = Buffer.from(JSON.stringify({ version: { name: '26.3', protocol: 775 }, players: { max: 20, online: 0 }, description: { text: 'stand-in' } }));
      const body = Buffer.concat([Buffer.from([0]), varInt(json.length), json]);
      s.end(Buffer.concat([varInt(body.length), body]));
    });
  }).listen(cfg.port, '127.0.0.1');
}

setTimeout(() => {
  say('Done (0.1s)! For help, type "help"');
  if (cfg.gc) fs.mkdirSync(path.join(here, '.nano'), { recursive: true }), fs.appendFileSync(path.join(here, '.nano', 'gc.log'), `${cfg.gc.join('\n')}\n`);
  for (let i = 0; i < (cfg.lag || 0); i++) {
    setTimeout(() => say(`Can't keep up! Is the server overloaded? Running ${2500 + i * 100}ms or ${50 + i} ticks behind`, 'WARN'), i * (cfg.lagEveryMs || 200));
  }
}, cfg.doneMs ?? 100);

if (cfg.freezeMs) setTimeout(() => { frozen = true; }, cfg.freezeMs);
if (cfg.opStopMs) setTimeout(() => { say('[Steve: Stopping the server]'); say('Stopping server'); setTimeout(() => process.exit(0), 100); }, cfg.opStopMs);
if (cfg.exitMs) {
  setTimeout(() => {
    for (const line of cfg.print || []) process.stdout.write(`${line}\n`);
    if (cfg.oom) {
      say('Encountered an unexpected exception', 'ERROR');
      process.stdout.write('java.lang.OutOfMemoryError: Java heap space\n\tat java.base/java.util.Arrays.copyOf(Arrays.java:3540)\n');
    }
    if (cfg.crashReport) {
      const dir = path.join(here, 'crash-reports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `crash-${new Date().toISOString().slice(0, 10)}_00.00.00-server.txt`);
      fs.writeFileSync(file, '---- Minecraft Crash Report ----\n// Shall we play a game?\n\nTime: 2026-11-10 12:00:00\nDescription: Exception in server tick loop\n\njava.lang.IllegalStateException: Stand-in broke on purpose\n\tat net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:100)\n');
      say(`This crash report has been saved to: ${file}`, 'ERROR');
    }
    setTimeout(() => process.exit(cfg.code ?? 1), 50);
  }, cfg.exitMs);
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    fs.appendFileSync(path.join(here, 'commands.log'), `${line}\n`);
    if (line === 'stop' && cfg.hangStop) { frozen = true; continue; }
    if (line === 'stop') { say('Stopping server'); setTimeout(() => process.exit(0), cfg.saveMs ?? 300); }
    else if (line === 'tps' && cfg.tps) setTimeout(() => say(`TPS from last 1m, 5m, 15m: ${cfg.tps}, ${cfg.tps}, ${cfg.tps}`), cfg.tpsDelayMs || 0);
    else if (line && !frozen) say(`Unknown or incomplete command, see below for error: ${line}`);
  }
});
setInterval(() => {}, 1000);
