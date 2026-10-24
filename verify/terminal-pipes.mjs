// Terminal sessions release their pipes in the main process: 50 terminals, closed from the tab (pty:kill) or ended by
// their shell (`exit`), leave the main process's PipeWrap count flat. node-pty's ConPTY agent never destroys its
// input socket, and a shell that exits by itself also keeps its output reader thread (a worker thread per session). Reads
// the main process over its inspector, and its thread count from Windows.
// Ports 9284 (renderer) and 9285 (main-process inspector).
import { execFileSync } from 'child_process';
import { launch } from './lib.mjs';

const ROUNDS = 25; // per way of ending a session
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspector(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]; } catch { await sleep(200); }
  }
  if (!target) throw new Error(`no main-process inspector on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const evaluate = (expression) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, (msg) => resolve(msg.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

// Least-squares slope of ys over xs.
function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return num / den;
}

const t = await launch({ fixture: 'core', port: 9284, name: 'terminal-pipes', args: ['--inspect=9285'] });
const { js, until, check } = t;
const main = await inspector(9285);
const pipes = () => main.evaluate(`process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length`);
const threads = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${t.pid}).Threads.Count`], { encoding: 'utf8', windowsHide: true }).trim());
// Settled: no session left in main, and the pipe count unchanged for a second (node-pty closes the output socket a
// second after the shell exits, and kill() asks a helper process for the console's processes first).
async function settledPipes() {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await pipes();
    if (n === last) return n;
    last = n;
  }
  return last;
}

async function round(way) {
  await js(`ide.terminal.open({ shell: 'cmd' }).then(() => true)`);
  await until(`ide.terminal.sessions().at(-1)?.id !== undefined && /[A-Za-z]:\\\\[^\\n]*>/.test(ide.terminal.text(ide.terminal.sessions().at(-1).id))`, 'cmd prompt', 20000);
  const id = await js(`ide.terminal.sessions().at(-1).id`);
  if (way === 'exit') {
    await js(`(ide.terminal.send('exit\\r', ${id}), true)`);
    await until(`ide.terminal.sessions().find((s) => s.id === ${id})?.exited === true`, 'shell exited', 15000);
  }
  await js(`(ide.terminal.close(${id}), true)`);
  await until(`!ide.terminal.sessions().some((s) => s.id === ${id})`, 'session closed', 10000);
}

try {
  for (const way of ['kill', 'exit']) {
    await round(way); // warm-up: the first session loads node-pty and starts its helpers
    const xs = [];
    const ys = [];
    const ts = [];
    const sample = async (i) => { xs.push(i); ys.push(await settledPipes()); await sleep(1500); ts.push(threads()); };
    await sample(0);
    for (let i = 1; i <= ROUNDS; i++) {
      await round(way);
      if (i % 5 === 0) await sample(i);
    }
    const perRound = slope(xs, ys);
    const threadsPerRound = slope(xs, ts);
    const ended = way === 'kill' ? 'closing the tab' : 'the shell exiting';
    console.log(`${way}: PipeWrap ${ys.join(' -> ')}, threads ${ts.join(' -> ')} over ${ROUNDS} terminals`);
    check(Math.abs(perRound) < 0.1, `terminals ended by ${ended} leave no pipes in the main process (${perRound.toFixed(2)} PipeWrap per terminal, ${ys[0]} -> ${ys.at(-1)})`);
    check(threadsPerRound < 0.5, `terminals ended by ${ended} leave no threads in the main process (${threadsPerRound.toFixed(2)} per terminal, ${ts[0]} -> ${ts.at(-1)})`);
  }
  const sessionsLeft = await main.evaluate(`process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length`);
  console.log(`ProcessWrap left: ${sessionsLeft}`);
  const errs = await js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => e.message))`);
  check(!errs.length, `no internal errors (${JSON.stringify(errs).slice(0, 300)})`);
} catch (err) {
  check(false, err.message);
}
main.close();
t.finish();
