// An installed copy ignores the PYIDE_* test hooks (trust everything, a replacement release key or update feed,
// stand-in programs, another user data folder) unless started with --pyide-test-env, which an environment variable
// cannot add; source runs and the installer suites keep them. Plain Node, no window. Usage: node verify/test-env.mjs
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { dropTestEnv, TEST_SWITCH, USER_SETTINGS } = require(path.join(ROOT, 'main', 'test-env.js'));
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const HOOKS = ['PYIDE_TRUST_ALL', 'PYIDE_RELEASE_PUBLIC_KEY', 'PYIDE_UPDATE_FEED', 'PYIDE_UPDATE_TEST', 'PYIDE_UPDATE_TEST_KIND', 'PYIDE_UPDATE_CONFIG',
  'PYIDE_MARKETPLACE_URL', 'PYIDE_BORE', 'PYIDE_CLOUDFLARED', 'PYIDE_NETSTAT', 'PYIDE_USER_DATA', 'PYIDE_MC_JAVA', 'PYIDE_MC_SOURCES',
  'PYIDE_PYTHON_FEED', 'PYIDE_TOOLCHAINS', 'PYIDE_CLAUDE_PATH', 'PYIDE_GH', 'PYIDE_OSV_URL', 'PYIDE_FAKE_OPEN_EXTERNAL', 'PYIDE_CUT_DIALOG',
  'PYIDE_SOMETHING_NEW'];
const make = () => ({ PATH: 'C:\\Windows', ...Object.fromEntries([...HOOKS, ...USER_SETTINGS].map((k) => [k, '1'])), pyide_trust_all: '1' });

let env = make();
const dropped = dropTestEnv({ packaged: true, argv: ['Nano Studio.exe', 'C:\\p'], env });
check(HOOKS.every((k) => !(k in env)) && !('pyide_trust_all' in env), `an installed copy drops every test hook, a new one and any letter case (${dropped.length} dropped)`);
check([...USER_SETTINGS].every((k) => env[k] === '1') && env.PATH === 'C:\\Windows', `it keeps the user settings (${[...USER_SETTINGS].join(', ')}) and other variables`);

env = make();
check(dropTestEnv({ packaged: true, argv: ['Nano Studio.exe', TEST_SWITCH], env }).length === 0 && HOOKS.every((k) => env[k] === '1'), `${TEST_SWITCH} keeps them (verify/installed.mjs, verify/update-e2e.mjs)`);
env = make();
check(dropTestEnv({ packaged: false, argv: ['electron.exe', '.'], env }).length === 0 && HOOKS.every((k) => env[k] === '1'), 'a source run keeps them (the verify suites)');

// The drop must run before anything reads process.env: right after electron is required, before any ./main module.
const main = readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const dropAt = main.indexOf("require('./main/test-env').dropTestEnv(");
const firstMain = main.search(/require\('\.\/main\/(?!test-env')/);
const firstRead = main.search(/process\.env\.PYIDE_/);
check(dropAt > 0 && dropAt < firstMain && dropAt < firstRead, 'main.js drops them before it requires a main module or reads a PYIDE_ variable');

const lib = readFileSync(path.join(ROOT, 'verify', 'lib.mjs'), 'utf8');
check(/\(exe \? \['--pyide-test-env'\] : \[\]\)/.test(lib) && TEST_SWITCH === '--pyide-test-env', 'verify/lib.mjs passes the switch when it starts an installed Nano Studio.exe');

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
