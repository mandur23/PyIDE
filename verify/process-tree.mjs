// verify/lib.mjs's process trees (pure Node, no window): descendants() skips processes whose parent PID was reused (an
// old system process whose long-gone parent had the root's PID, as seen on the CI runner), keeps nested children, and
// processSnapshot() finds a real child and grandchild of this process with start times.
import { spawn } from 'child_process';
import { descendants, processSnapshot } from './lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (rows) => rows.map((r) => `${r.name}:${r.pid}`).join(', ');

// ---------- a fake snapshot ----------
const T = 1_800_000_000_000;
const row = (pid, ppid, name, created) => ({ pid, ppid, name, cmd: name, created, workingSet: 0, kernelMs: 0, userMs: 0 });
// csrss and wininit were started at boot by an smss.exe with PID 560 that has long exited; PID 560 is now the IDE.
const snap = [
  row(4, 0, 'System', T - 9e6),
  row(760, 560, 'csrss.exe', T - 9e6 + 20),
  row(864, 560, 'wininit.exe', T - 9e6 + 30),
  row(980, 864, 'services.exe', T - 9e6 + 40),
  row(720, 980, 'svchost.exe', T - 9e6 + 50),
  row(560, 1, 'electron.exe', T), // the IDE
  row(600, 560, 'electron.exe', T + 100), // renderer
  row(6260, 560, 'git.exe', T + 200),
  row(376, 6260, 'conhost.exe', T + 201),
  row(752, 6260, 'git-remote-http.exe', T + 300),
  row(753, 752, 'git.exe', T + 300), // started in the same millisecond as its parent: still a child
  row(9000, 600, 'old.exe', T - 5), // parent PID 600 reused: started before the renderer, so not its child
];
const tree = descendants(snap, 560);
const pids = tree.map((r) => r.pid);
check(!tree.some((r) => /csrss|wininit|services|svchost|old\.exe/.test(r.name)), `system processes whose old parent had the IDE's PID are not the IDE's (${names(tree)})`);
check(['600', '6260', '376', '752', '753'].every((p) => pids.includes(Number(p))) && tree.length === 5, `nested children, grandchildren and a same-millisecond child are (${names(tree)})`);
check(pids.indexOf(6260) < pids.indexOf(752) && pids.indexOf(752) < pids.indexOf(753), 'depth first: a parent comes before its children');
const withRoot = descendants(snap, 560, { includeRoot: true });
check(withRoot[0]?.pid === 560 && withRoot[0].name === 'electron.exe' && withRoot.length === 6, `includeRoot puts the root first (${names(withRoot.slice(0, 2))})`);
// The root has exited: its children count only if they started after `since`.
const orphaned = snap.filter((r) => r.pid !== 560);
const late = descendants(orphaned, 560, { includeRoot: true, since: T - 1 });
check(late.length === 5 && !late.some((r) => r.pid === 560) && !late.some((r) => /csrss|wininit/.test(r.name)), `with the root gone, children started after "since" count, the old ones do not (${names(late)})`);
check(descendants(orphaned, 560, { since: T + 150 }).map((r) => r.pid).join() === '6260,376,752,753', 'and "since" is a lower bound for the direct children');
// A loop in the table (pid reuse in both directions) ends.
check(descendants([row(1, 2, 'a', T), row(2, 1, 'b', T)], 1).length === 1, 'a parent loop does not walk forever');

// ---------- the real process table ----------
const child = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
let mine = [];
for (let end = Date.now() + 15000; Date.now() < end; await sleep(200)) {
  mine = descendants(processSnapshot(), process.pid);
  if (mine.filter((r) => /setInterval/.test(r.cmd)).length >= 2) break;
}
const all = processSnapshot();
const me = all.find((r) => r.pid === process.pid);
const kid = mine.find((r) => r.pid === child.pid);
check(me && me.created > Date.now() - 600000 && me.created <= Date.now() && me.name === 'node.exe' && me.workingSet > 0 && me.userMs + me.kernelMs > 0,
  `processSnapshot has this process with its start time, working set and CPU time (${me && `${new Date(me.created).toISOString()}, ${Math.round(me.workingSet / 1048576)} MB, ${Math.round(me.userMs + me.kernelMs)} ms`})`);
check(kid && kid.created >= me.created && mine.some((r) => r.ppid === child.pid && r.created >= kid.created) && /setInterval/.test(kid.cmd),
  `descendants finds a real child and grandchild (${names(mine)})`);
check(all.length > 20 && !mine.some((r) => /^(csrss|wininit|services|svchost|smss|lsass)\.exe$/i.test(r.name)), `no system process is counted under this process (${all.length} processes)`);
// (the snapshot's own PowerShell shows up under this process too, and has exited by now)
for (const r of mine.filter((x) => /setInterval/.test(x.cmd)).reverse()) try { process.kill(r.pid); } catch {}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
