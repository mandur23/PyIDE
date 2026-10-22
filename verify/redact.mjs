// Pure Node (no window): main/diagnostics/redact.js redactPaths and remoteRepoNames, the scrubbing behind
// Help > Report a Problem. A table of inputs and the exact text that may leave the computer.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { redactPaths, remoteRepoNames } = require('../main/diagnostics/redact.js');

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

console.log(`${CASES.length + 6 - failed}/${CASES.length + 6} passed`);
process.exit(failed ? 1 : 0);
