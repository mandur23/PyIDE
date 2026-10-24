// main/features/tests.js without a window: tests:start keeps its command line, and tests:debugTarget gives the debugger
// the same pytest or unittest run (script, parameters, environment with the .env files and the report), whose report
// tests:poll reads and releases. The run itself goes through the default Python (pytest as in run-tools).
import { spawnSync } from 'child_process';
import { cpSync, existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { tempDir } from './lib.mjs';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const handlers = {};
const started = [];
require(path.join(APP, 'main', 'features', 'tests.js')).register({
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  startProcess: (cmd, args, opts) => { started.push({ cmd, args, opts }); return started.length; },
  unpackedDir: APP,
});
const call = (ch, ...args) => handlers[ch]({}, ...args);
const helpers = path.join(APP, 'renderer', 'features', 'tests');
const root = path.join(tempDir('tests-debug-target'), 'project');
cpSync(path.join(APP, 'verify', 'fixtures', 'tests-debug-run'), root, { recursive: true });
writeFileSync(path.join(root, '.env'), 'FROM_DOTENV=yes\n');
const python = spawnSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const interp = { cmd: python, args: [], executable: python };
// The final poll removes the report folder in the background.
const gone = async (dir) => { for (let i = 0; i < 50 && existsSync(dir); i++) await new Promise((r) => setTimeout(r, 100)); return !existsSync(dir); };
const opts = (runner, extra = {}) => ({ runner, targets: ['test_calc.py'], args: runner === 'pytest' ? ['-q'] : [], cwd: root, root, env: { MINE: '1' }, ...extra });

try {
  const run = await call('tests:start', interp, opts('pytest'));
  check(started[0].cmd === python && started[0].args.join(' ') === '-m pytest -p pyide_pytest_plugin -q test_calc.py' && started[0].opts.cwd === root,
    `tests:start runs python -m pytest with the reporting plugin as before (${started[0].args.join(' ')})`);
  check(run.command === `${python} -m pytest -p pyide_pytest_plugin -q test_calc.py`, `tests:start reports its command (${run.command})`);
  await call('tests:poll', run.id, true);

  const dbg = await call('tests:debugTarget', interp, opts('pytest'));
  check(dbg.script === '-m' && dbg.params.join(' ') === 'pytest -p pyide_pytest_plugin -q test_calc.py' && dbg.cwd === root,
    `tests:debugTarget hands the debugger -m pytest and its arguments (${dbg.script} ${dbg.params.join(' ')})`);
  check(started.length === 1, 'tests:debugTarget starts no process (the debugger does)');
  const report = dbg.env.PYIDE_TEST_REPORT;
  check(existsSync(report) && dbg.env.MINE === '1' && dbg.env.FROM_DOTENV === 'yes' && dbg.env.PYTHONPATH.split(';')[0] === helpers,
    'the environment holds the report file, the configuration and .env variables, and the helpers on PYTHONPATH');
  check(/^debug-\d+$/.test(dbg.id) && dbg.command.includes('-m debugpy -m pytest'), `a report id for tests:poll and a debugpy command line (${dbg.id})`);
  // The debugger runs `python <script> <params>` with this environment; the same command fills the report.
  const r = spawnSync(python, [dbg.script, ...dbg.params], { cwd: dbg.cwd, env: { ...process.env, ...dbg.env }, encoding: 'utf8' });
  const events = await call('tests:poll', dbg.id, true);
  const outcomes = events.filter((e) => e.e === 'result').map((e) => `${e.id}=${e.outcome}`).join(' ');
  check(outcomes === 'test_calc.py::test_add=passed test_calc.py::test_wrong=failed' && events.at(-1)?.e === 'done' && events.at(-1).exit === r.status,
    `the run's report reaches tests:poll with the results and pytest's exit status (${outcomes}; done ${events.at(-1)?.exit})`);
  check(await gone(path.dirname(report)), 'the final poll releases the report folder');

  const ut = await call('tests:debugTarget', interp, opts('unittest'));
  check(ut.script === path.join(helpers, 'pyide_unittest_runner.py') && ut.params.join(' ') === `${root} test_calc.py`,
    `without pytest the debugger runs the unittest runner on the project (${path.basename(ut.script)} ${ut.params.length} parameters)`);
  spawnSync(python, [ut.script, ...ut.params], { cwd: ut.cwd, env: { ...process.env, ...ut.env }, encoding: 'utf8' });
  const utEvents = await call('tests:poll', ut.id, true);
  // unittest finds TestCase classes only, so the fixture's pytest functions give an empty but complete report.
  check(utEvents.map((e) => e.e).join() === 'collected,done', `the unittest runner writes its report there (${utEvents.map((e) => e.e).join()})`);
  check(await gone(path.dirname(ut.env.PYIDE_TEST_REPORT)), 'its report is released by the final poll too');
} catch (err) {
  check(false, err.stack.split('\n').slice(0, 2).join(' '));
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
