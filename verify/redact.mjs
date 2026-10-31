// Pure Node (no window): main/diagnostics/redact.js redactPaths and remoteRepoNames, the scrubbing behind
// Help > Report a Problem. A table of inputs and the exact text that may leave the computer.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MASK, redactObject, redactPaths, remoteRepoNames, scrubText } = require('../main/diagnostics/redact.js');

const opts = {
  home: 'C:\\Users\\John Smith',
  projects: ['D:\\work\\acme-billing', 'C:\\Users\\John Smith\\dev\\Secret Plan\\'],
  names: ['moonshot-api'],
};
const CASES = [
  // home folder, any user folder, names with spaces
  ['C:\\Users\\John Smith\\x\\y.py', '~\\x\\y.py'],
  ['C:\\Users\\Jane Doe\\x', 'C:\\Users\\<user>\\x'],
  ['c:/users/Jane Doe/x', 'c:/users/<user>/x'],
  ['opened C:\\Users\\jane and more', 'opened C:\\Users\\<user> and more'],
  ['C:\\Users\\jane, see D:\\x', 'C:\\Users\\<user>, see D:\\x'],
  ['file:///C:/Users/Jane%20Doe/x.py', 'file:///C:/Users/<user>/x.py'],
  ['C:\\Documents and Settings\\bob\\x', 'C:\\Documents and Settings\\<user>\\x'],
  ['/home/alice/proj/x.py', '/home/<user>/proj/x.py'],
  ['/Users/alice/Library/x', '/Users/<user>/Library/x'],
  ['/mnt/c/Users/Alice B/x', '/mnt/c/Users/<user>/x'],
  ['\\\\wsl$\\Ubuntu\\home\\alice\\x.py', '\\\\wsl$\\Ubuntu\\home\\<user>\\x.py'],
  ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\alice\\x.py', '\\\\wsl.localhost\\Ubuntu-22.04\\home\\<user>\\x.py'],
  ['cwd /home/alice', 'cwd /home/<user>'],
  // project folders and names as whole words
  ['D:\\work\\acme-billing\\main.py', '<project>\\main.py'],
  ['C:\\Users\\John Smith\\dev\\Secret Plan\\a.py', '<project>\\a.py'],
  ['opened acme-billing (3 files)', 'opened <project> (3 files)'],
  ['acme-billing.py and ACME-BILLING', '<project>.py and <project>'],
  ['acme-billing2 acme-billing-old xacme-billing', 'acme-billing2 acme-billing-old xacme-billing'],
  ['Secret Plan: done', '<project>: done'],
  ['pushing moonshot-api failed', 'pushing <project> failed'],
  // e-mail addresses and URL users
  ['Author: John <john.smith+git@example.co.uk>', 'Author: John <<email>>'],
  ['mail bob@corp.example.com.', 'mail <email>.'],
  ["fatal: unable to access 'https://jsmith@github.com/jsmith/moonshot-api.git/'", "fatal: unable to access 'https://<user>@github.com/jsmith/<project>.git/'"],
  ['https://jsmith:hunter2pass@gitlab.example.com/x.git', 'https://<user>@gitlab.example.com/x.git'],
  ['ssh://git@host.example.com:22/team/x.git', 'ssh://<user>@host.example.com:22/team/x.git'],
  ['git@github.com:jsmith/other.git', 'git@github.com:jsmith/other.git'],
  // unchanged: stack frames, versions, package specs, decorators, the app's own name
  ['    at Object.<anonymous> (node:internal/modules/cjs/loader:1554:14)', null],
  ['    at f (file:///C:/Program%20Files/PyIDE/resources/app.asar/renderer/core/ide.js:10:5)', null],
  ['    at async Promise.all (index 0)', null],
  ['PyIDE 0.2.3, Electron 38.1.2, Chromium 140.0.7339.80, node 22.18.0', null],
  ['installed react@18.3.1 and @types/node@20.1.0, pkg@1.0.0-beta', null],
  ['@property def x(self): return a@b', null],
  ['File "<project>\\main.py", line 3, in <module>', null],
  ['2026-10-22 10:00:01.123 [info] #git fetch origin', null],
];

let failed = 0;
const check = (ok, label) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
for (const [input, expected] of CASES) {
  const out = redactPaths(input, opts);
  const want = expected ?? input;
  check(out === want, `${JSON.stringify(input)} -> ${JSON.stringify(out)}${out === want ? '' : ` (expected ${JSON.stringify(want)})`}`);
}

// Generic folder names (the test fixtures' "project", the app's own name) are not replaced as words.
check(redactPaths('Trust and Open Project for project PyIDE', { projects: ['C:\\x\\project', 'C:\\y\\PyIDE'] }) === 'Trust and Open Project for project PyIDE',
  'generic project folder names stay as words');
check(redactPaths('ab x', { projects: ['C:\\x\\ab'] }) === 'ab x', 'names shorter than 3 characters stay');
// Idempotent: a second pass changes nothing.
const once = CASES.map(([i]) => redactPaths(i, opts));
check(once.every((s) => redactPaths(s, opts) === s), 'a second pass changes nothing');

// Remote repository names found in log lines.
const LOG = [
  "2026-10-22 [error] #git push: fatal: unable to access 'https://jsmith@github.com/jsmith/moonshot-api.git/': 403",
  '2026-10-22 [info] #git remote origin git@gitlab.com:team/billing-core.git',
  '2026-10-22 [info] #git fetch https://github.com/acme/infra-tools failed',
  '2026-10-22 [info] ssh://git@host.example.com/x/deploy-scripts.git',
  "2026-10-22 [error] #git pull: fatal: unable to access 'https://jsmith:<redacted>@github.com/jsmith/ledger-app.git/': 403",
  '2026-10-22 [info] #git see <https://gitlab.com/team/angle-repo>.',
  '2026-10-22 [info] update feed https://github.com/mandur23/PyIDE/releases/latest.yml',
  '2026-10-22 [info] downloaded https://github.com/astral-sh/ruff/releases/x.zip',
  '2026-10-22 [info] see https://docs.python.org/3/library/os.html',
].join('\n');
const remotes = remoteRepoNames(LOG).sort();
check(JSON.stringify(remotes) === JSON.stringify(['angle-repo', 'billing-core', 'deploy-scripts', 'infra-tools', 'ledger-app', 'moonshot-api']),
  `remote repository names come from git URLs only (${JSON.stringify(remotes)})`);
check(redactPaths('cloning billing-core into x', { names: remotes }) === 'cloning <project> into x', 'a remote name standing alone becomes <project>');

// Secrets in command lines (main.js logs every program it starts) and free text, as scrubText writes them to the log.
const SCRUB = [
  ['#3 started (pid 9): mysql.exe --password hunter2 db', `#3 started (pid 9): mysql.exe --password ${MASK} db`],
  ['tool -Password "two words" --verbose', `tool -Password ${MASK} --verbose`],
  ['tool --api-key abc123 --token=abc123 --db-pass x', `tool --api-key ${MASK} --token=${MASK} --db-pass ${MASK}`],
  ['mysql -u root -phunter2 db', `mysql -u root -p${MASK} db`],
  ['C:\\xampp\\bin\\mysql.exe -h db -psecret db', `C:\\xampp\\bin\\mysql.exe -h db -p${MASK} db`],
  ['sshpass -p hunter2 ssh host', `sshpass -p ${MASK} ssh host`],
  ['-phunter2', `-p${MASK}`],
  ['Server=db;Uid=bob;Pwd=hunter2;Database=x', `Server=db;Uid=bob;Pwd=${MASK};Database=x`],
  ['curl -u bob:hunter2 https://example.com', `curl -u bob:${MASK} https://example.com`],
  ['curl --user=bob:hunter2 -x host', `curl --user=bob:${MASK} -x host`],
  ['redis://:hunter2@host:6379/0', `redis://:${MASK}@host:6379/0`],
  ['https://bob:p@ss@host/x', `https://bob:${MASK}@host/x`],
  ['Authorization: token abcdef0123456789', `Authorization: ${MASK}`],
  ['-H "Authorization: Digest a=1, b=2" url', `-H "Authorization: ${MASK}" url`],
  ['Cookie: sid=abc; theme=dark', `Cookie: ${MASK}`],
  ['password=two words', `password=${MASK}`],
  ['Server=db;Password=two words;Database=x', `Server=db;Password=${MASK};Database=x`],
  ['"password": "two words", "user": "bob"', `"password": ${MASK}, "user": "bob"`],
  ['secret_key = two words', `secret_key = ${MASK}`],
  // unchanged: what only looks like one
  ['python -u C:\\proj\\main.py', null],
  ['python -u C:/proj/main.py --max-tokens 100 --tokenizer gpt2', null],
  ['docker run -u 1000:1000 -p8080:80 img', null],
  ['pip install --user requests', null],
  ['gcc -pthread -pipe -pedantic x.c', null],
  ['pytest -pno:cacheprovider -p xdist', null],
  ['mkdir -p build/out', null],
  ['tests passed: 5 failed: 0', null],
  ['http://host:8080/a@b.png', null],
  ['Unexpected token: foo bar', 'Unexpected token: <redacted> bar'],
];
for (const [input, expected] of SCRUB) {
  const out = scrubText(input);
  const want = expected ?? input;
  check(out === want, `${JSON.stringify(input)} -> ${JSON.stringify(out)}${out === want ? '' : ` (expected ${JSON.stringify(want)})`}`);
}
check(SCRUB.every(([i]) => scrubText(scrubText(i)) === scrubText(i)), 'a second scrub changes nothing');

// A diagnostic report keeps settings but nothing the user typed to run something.
const report = redactObject({
  'editor.fontSize': 14,
  'pyconsole.history': ['connect(password="hunter2")'],
  'runConfigs:C:\\p': { selected: 'a', configs: [{ id: 'a', type: 'python', name: 'main', script: 'main.py', params: '--db bob secret', env: 'API=abc;MODE=x', interpOptions: '-X dev', vmOptions: '-Dpw=x' }] },
  'tools.external': [{ name: 'lint', program: 'ruff', args: '--config secret.toml' }],
  'terminal.env': { STAGE: 'prod' },
  environment: { HOME: '/home/bob' },
  envFiles: '.env',
});
const reported = JSON.stringify(report);
check(!/hunter2|bob secret|API=abc|-X dev|-Dpw|secret\.toml|prod|home\/bob/.test(reported), `a report drops console history, run parameters and environment values (${reported})`);
check(report['editor.fontSize'] === 14 && report['runConfigs:C:\\p'].configs[0].name === 'main' && report['runConfigs:C:\\p'].configs[0].type === 'python' && report.envFiles === '.env',
  'a report keeps ordinary settings and the shape of run configurations');

// Every log line and the whole log in a diagnostic archive pass through scrubText.
const started = performance.now();
const log = Array.from({ length: 120000 }, (_, i) => `2026-10-22 10:00:01,123 [ ${i}]   INFO - #process - #${i} started (pid 1): python -u C:\\proj\\main.py --max-tokens 100 in C:\\proj\\sub-folder`).join('\n');
scrubText(log);
const ms = Math.round(performance.now() - started);
check(ms < 5000, `scrubbing a ${Math.round(log.length / 2 ** 20)} MB log takes ${ms} ms`);

const total = CASES.length + SCRUB.length + 10;
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
