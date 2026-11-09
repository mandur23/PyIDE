// Runs one shard of the CI suites (verify/ci-suites.json) on this machine, one suite after another:
//   node verify/ci-shard.mjs --shard <i> --of <n>     run shard i (1-based) of n
//   node verify/ci-shard.mjs --of <n> --list          print every shard's suites and expected seconds
// --suites <file> reads another list (a check of this runner).
// The suites are spread by their measured seconds (the longest first, each to the least loaded shard), so the shards
// end at about the same time and the same list always gives the same shards. A suite without seconds counts as 60.
// Every suite runs even after one fails, as the steps of one job did (if: !cancelled()); the exit code is 1 when any
// failed or timed out, and a table of the shard goes to the job summary.
import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SECONDS = 60;

export function loadSuites(file = path.join(ROOT, 'verify', 'ci-suites.json')) {
  const suites = JSON.parse(readFileSync(file, 'utf8'));
  const names = new Set();
  for (const s of suites) {
    if (!s.name || !s.file || !Number.isFinite(s.timeout)) throw new Error(`ci-suites.json: incomplete entry ${JSON.stringify(s)}`);
    if (names.has(s.name)) throw new Error(`ci-suites.json: "${s.name}" is listed twice`);
    names.add(s.name);
    if (!existsSync(path.join(ROOT, s.file))) throw new Error(`ci-suites.json: ${s.file} does not exist`);
  }
  return suites;
}

// [[suite...] per shard], each in the list's own order.
export function shards(suites, n) {
  const weight = (s) => s.seconds ?? DEFAULT_SECONDS;
  const load = Array(n).fill(0);
  const of = new Map();
  const order = suites.map((s, i) => [s, i]).sort((a, b) => weight(b[0]) - weight(a[0]) || a[1] - b[1]);
  for (const [s] of order) {
    const k = load.indexOf(Math.min(...load));
    load[k] += weight(s);
    of.set(s, k);
  }
  return Array.from({ length: n }, (_, k) => suites.filter((s) => of.get(s) === k));
}

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function runSuite(s) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [s.file, ...(s.args || [])], { cwd: ROOT, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, s.timeout * 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ name: s.name, ok: code === 0 && !timedOut, code, timedOut, seconds: Math.round((Date.now() - start) / 1000) });
    });
  });
}

function args(argv) {
  const o = { shard: null, of: null, list: false, suites: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shard') o.shard = Number(argv[++i]);
    else if (argv[i] === '--of') o.of = Number(argv[++i]);
    else if (argv[i] === '--list') o.list = true;
    else if (argv[i] === '--suites') o.suites = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(o.of) || o.of < 1) throw new Error('--of <n> is required');
  if (!o.list && !(Number.isInteger(o.shard) && o.shard >= 1 && o.shard <= o.of)) throw new Error('--shard <i> must be 1..n');
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const all = shards(loadSuites(o.suites), o.of);
  if (o.list) {
    all.forEach((list, k) => console.log(`shard ${k + 1}: ${list.length} suites, ${list.reduce((t, s) => t + (s.seconds ?? DEFAULT_SECONDS), 0)} s\n  ${list.map((s) => s.name).join(', ')}`));
    return;
  }
  const mine = all[o.shard - 1];
  console.log(`shard ${o.shard} of ${o.of}: ${mine.length} suites`);
  const results = [];
  for (const s of mine) {
    console.log(`::group::${s.name}`);
    const r = await runSuite(s);
    console.log('::endgroup::');
    const why = r.timedOut ? `timed out after ${s.timeout} min` : `exit ${r.code}`;
    console.log(r.ok ? `ok   ${s.name} (${r.seconds} s)` : `::error title=${s.name}::${s.name} failed (${why}, ${r.seconds} s)`);
    results.push({ ...r, why });
  }
  const failed = results.filter((r) => !r.ok);
  const table = ['| suite | result | seconds |', '| --- | --- | --- |', ...results.map((r) => `| ${r.name} | ${r.ok ? 'passed' : `**failed** (${r.why})`} | ${r.seconds} |`)];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Shard ${o.shard} of ${o.of}: ${results.length - failed.length}/${results.length} passed\n\n${table.join('\n')}\n`);
  console.log(`\nshard ${o.shard}: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.name).join(', ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 2; });
}
