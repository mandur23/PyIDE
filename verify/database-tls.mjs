// SSL mode of PostgreSQL, CockroachDB, MySQL and MariaDB data sources (main/db/ssl.js) with the real pg and mysql2 drivers
// (npm, into a temp driver directory) against stand-in servers (verify/fixtures/database-tls/servers.mjs): Automatic
// follows the host for records saved without the field, a server without TLS and a certificate that cannot be verified
// fail with a message naming the setting and with no password sent, nothing ever falls back to clear text, and Export
// Data's second connection keeps TLS. Then in the app: the dialog field, Test Connection, the tree, a loopback source
// added the way the Install Manager adds one, and Korean. Ports 9960-9961.
import { execSync, spawn } from 'child_process';
import dns from 'dns';
import { mkdtempSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { CERT_FILE, startMysql, startPostgres } from './fixtures/database-tls/servers.mjs';

const driverDir = mkdtempSync(path.join(tmpdir(), 'pyide-db-tls-drivers-'));
process.env.PYIDE_DB_DRIVERS = driverDir;
execSync(`npm install --prefix "${driverDir}" --no-audit --no-fund --loglevel error pg@8 mysql2@3`, { stdio: 'ignore', windowsHide: true });
const require = createRequire(import.meta.url);
const { DRIVERS } = require('../main/db/drivers.js');
const { isLoopback, sslMode } = require('../main/db/ssl.js');

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const SECRET = 'tls-s3cret-Pw';
const REMOTE = 'db.example.test';

// The stand-ins run on this computer, so a name that is not loopback must resolve here for the host rule to be tested.
const realLookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  if (host !== REMOTE) return realLookup(host, options, callback);
  const cb = typeof options === 'function' ? options : callback;
  return process.nextTick(() => (options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
};

check(['localhost', 'LOCALHOST', '127.0.0.1', '127.5.5.5', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost.', '', undefined].every(isLoopback), 'loopback hosts, including no host at all');
check(!['db.example.com', '10.0.0.5', '192.168.0.2', '0.0.0.0', 'localhost.example.com', '127.0.0.1.example.com', '::2'].some(isLoopback), 'other hosts are not loopback, private addresses included');
check(q([{ host: '127.0.0.1' }, { host: 'db.example.com' }, { host: 'db.example.com', ssl: 'off' }, { host: 'localhost', ssl: 'verify' }, { host: 'db.example.com', ssl: 'nonsense' }].map(sslMode)) === q(['off', 'require', 'off', 'verify', 'require']),
  'Automatic: Off on loopback, Require elsewhere; a stored mode wins; a value that is no mode counts as Automatic');

const open = (kind, cfg) => DRIVERS[kind].open({ user: 'ada', password: SECRET, database: 'shop', ...cfg }, {});
const failure = async (kind, cfg) => {
  try {
    const a = await open(kind, cfg);
    await a.close();
    return null;
  } catch (err) { return err.message; }
};
const fresh = (seen) => { seen.sslRequests = 0; seen.connections.length = 0; };
// A password crossed only if the server received one on a connection that was not encrypted.
const leaked = (seen) => seen.connections.some((c) => !c.encrypted && (c.password || c.passwordSent));
const gotPassword = (seen) => seen.connections.some((c) => c.encrypted && (c.password === SECRET || c.passwordSent));

const [pgPlain, pgTls, myPlain, myTls] = await Promise.all([startPostgres({ tls: false }), startPostgres({ tls: true }), startMysql({ tls: false }), startMysql({ tls: true })]);
const families = [
  ['postgres', pgPlain, pgTls], ['cockroachdb', pgPlain, pgTls], ['mysql', myPlain, myTls], ['mariadb', myPlain, myTls],
];

let a;
try {
  for (const [kind, plain, secure] of families) {
    fresh(plain.seen);
    const local = await open(kind, { host: '127.0.0.1', port: plain.port });
    check(/stand-in/.test(await local.version()) && plain.seen.sslRequests === 0, `${kind}: a saved loopback source without the field connects as before, with no SSL request`);
    await local.close();

    fresh(plain.seen);
    const saved = await failure(kind, { host: REMOTE, port: plain.port });
    check(/SSL mode/.test(saved || '') && /Off/.test(saved) && !plain.seen.connections.length,
      `${kind}: a saved remote source without the field fails against a server without TLS, names the setting and sends no password (${saved})`);

    fresh(secure.seen);
    const remote = await open(kind, { host: REMOTE, port: secure.port });
    await remote.version();
    await remote.close();
    check(secure.seen.sslRequests === 1 && gotPassword(secure.seen) && !leaked(secure.seen), `${kind}: the same source on a server with TLS is encrypted, also with a self-signed certificate`);

    fresh(plain.seen);
    const required = await failure(kind, { host: '127.0.0.1', port: plain.port, ssl: 'require' });
    check(/SSL mode/.test(required || '') && !plain.seen.connections.length, `${kind}: Require on loopback is honoured and never falls back to clear text`);

    fresh(plain.seen);
    const off = await open(kind, { host: REMOTE, port: plain.port, ssl: 'off' });
    await off.close();
    check(plain.seen.sslRequests === 0, `${kind}: Off on a remote host connects in clear text, which only that choice allows`);

    fresh(secure.seen);
    const verifySelfSigned = await failure(kind, { host: 'localhost', port: secure.port, ssl: 'verify' });
    check(/SSL mode/.test(verifySelfSigned || '') && /Require/.test(verifySelfSigned) && !gotPassword(secure.seen), `${kind}: Verify refuses a certificate nothing vouches for and sends no password (${verifySelfSigned})`);
  }

  // The stand-ins' certificate becomes trusted in a process started with it as an extra CA.
  const inChild = (kind, port, host) => new Promise((resolve) => {
    const code = `const dns = require('dns');
      const lookup = dns.lookup;
      dns.lookup = (h, o, cb) => (h === ${q(REMOTE)} ? process.nextTick(() => (o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : (cb || o)(null, '127.0.0.1', 4))) : lookup(h, o, cb));
      const { DRIVERS } = require(${q(path.resolve('main/db/drivers.js'))});
      DRIVERS[${q(kind)}].open({ host: ${q(host)}, port: ${port}, user: 'ada', password: ${q(SECRET)}, database: 'shop', ssl: 'verify' }, {})
        .then(async (a) => { await a.close(); console.log('connected'); process.exit(0); }, (e) => { console.log(e.message); process.exit(0); });`;
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: CERT_FILE }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out.trim()));
  });
  for (const [kind, , secure] of [families[0], families[2]]) {
    const trusted = await inChild(kind, secure.port, 'localhost');
    check(trusted === 'connected', `${kind}: Verify connects to a certificate the machine trusts, for the name it was issued to (${trusted})`);
    for (const host of [REMOTE, '127.0.0.1']) {
      const other = await inChild(kind, secure.port, host);
      check(/SSL mode/.test(other), `${kind}: Verify refuses a trusted certificate reached as ${host} (${other})`);
    }
  }

  fresh(pgTls.seen);
  const exporter = await open('postgres', { host: REMOTE, port: pgTls.port });
  await exporter.cursor('SELECT 1', { readOnly: true }).catch(() => {});
  await exporter.close();
  check(pgTls.seen.sslRequests === 2 && pgTls.seen.connections.length === 2 && pgTls.seen.connections.every((c) => c.encrypted), `PostgreSQL: Export Data's own connection is encrypted too (${pgTls.seen.connections.length} connections)`);
  fresh(myTls.seen);
  const myExporter = await open('mysql', { host: REMOTE, port: myTls.port });
  const cursor = await Promise.race([myExporter.cursor('SELECT VERSION()'), new Promise((r) => setTimeout(r, 1500))]).catch(() => null);
  await cursor?.close?.();
  await myExporter.close();
  check(myTls.seen.sslRequests === 2 && myTls.seen.connections.every((c) => c.encrypted), `MySQL: Export Data's own connection is encrypted too (${myTls.seen.connections.length} connections)`);

  // ---------- in the app ----------
  fresh(pgPlain.seen);
  a = await launch({ fixture: 'database', port: 9960, name: 'database-tls' });
  const setInput = (selector, value) => a.js(`(() => { const n = document.querySelector(${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const setSelect = (selector, value) => a.js(`(() => { const n = document.querySelector(${q(selector)}); n.value = ${q(value)}; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const addDialog = async (t, label) => {
    await t.js(`ide.toolWindows.get('Database').show()`);
    await t.click('#dbAdd');
    await t.until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes(${q(label)}))`, 'add menu');
    await t.js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes(${q(label)})).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await t.until(`!!document.querySelector('.db-dialog #dbField-ssl')`, `${label} dialog`);
  };
  await addDialog(a, 'PostgreSQL');
  const options = await a.js(`[...document.querySelector('#dbField-ssl').options].map(o => o.value)`);
  check(q(options) === q(['', 'off', 'require', 'verify']) && await a.js(`document.querySelector('#dbField-ssl').value === ''`), `the PostgreSQL form asks for the SSL mode, Automatic by default (${q(options)})`);
  await setInput('#dbField-host', '127.0.0.1');
  await setInput('#dbField-port', String(pgPlain.port));
  await setInput('#dbField-user', 'ada');
  await setInput('#dbField-password', SECRET);
  await setSelect('#dbField-ssl', 'require');
  const test = async (t) => {
    await t.js(`document.querySelector('#dbTestResult').className = 'db-test-result'`);
    await t.click('#dbTest');
    await t.until(`/ok|err/.test(document.querySelector('#dbTestResult').className)`, 'test connection result', 20000);
    return t.js(`document.querySelector('#dbTestResult').textContent`);
  };
  const refused = await test(a);
  check(/set SSL mode to Off/.test(refused), `Test Connection names the SSL setting (${refused})`);
  await setSelect('#dbField-ssl', 'off');
  const plainTest = await test(a);
  check(/PostgreSQL 16\.0 stand-in/.test(plainTest), `with Off it connects (${plainTest})`);
  await setInput('#dbName', 'strict');
  await setSelect('#dbField-ssl', 'require');
  await a.js(`[...document.querySelectorAll('.db-dialog .dialog-buttons button')].find(b => b.textContent === 'OK').click()`);
  await a.until(`!document.querySelector('.db-dialog') && ide.database.list().some(s => s.name === 'strict')`, 'source saved');
  const strict = await a.js(`ide.database.list().find(s => s.name === 'strict')`);
  check(strict.ssl === 'require' && strict.hasPassword && !('secret' in strict) && !q(strict).includes(SECRET), 'the mode is saved with the source; the password stays out of what the renderer sees');
  const r = await a.js(`ide.database.query(${q(strict.id)}, 'SELECT version()')`);
  check(!r.ok && /SSL mode/.test(r.error), `a saved source shows the same message in the console (${r.error})`);
  await a.until(`[...document.querySelectorAll('#dbTree .db-source .db-dot')].some(n => n.classList.contains('db-state-error') && /SSL mode/.test(n.title))`, 'state dot').then(() => check(true, 'and on its tree row'), () => check(false, 'and on its tree row'));

  const installId = await a.js(`ide.database.addDataSource({ kind: 'postgres', name: 'PostgreSQL 18.6 (Nano Studio)', host: '127.0.0.1', port: ${pgPlain.port}, user: 'postgres', password: ${q(SECRET)}, database: 'postgres' })`);
  const installed = await a.js(`ide.database.query(${q(installId)}, 'SELECT version()')`);
  check(installed.ok && !('ssl' in await a.js(`ide.database.list().find(s => s.id === ${q(installId)})`)), `a source the Install Manager adds on 127.0.0.1 stays Automatic and connects (${q(installed.rows || installed.error)})`);

  await a.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${q(a.consoleErrors)}` : ''}`);
  a.close();

  const b = await launch({ fixture: 'database', port: 9961, name: 'database-tls-ko', userData: a.userData, lang: 'ko-KR' });
  try {
    await addDialog(b, 'MySQL');
    const label = await b.js(`document.querySelector('#dbField-ssl').closest('label').firstChild.textContent`);
    const labels = await b.js(`[...document.querySelector('#dbField-ssl').options].map(o => o.textContent)`);
    check(label === 'SSL 모드' && labels.every((t) => /[가-힣]/.test(t)), `the field is in Korean (${label}: ${q(labels)})`);
    await b.js(`(() => { for (const [id, v] of [['#dbField-host', '127.0.0.1'], ['#dbField-port', ${q(String(myPlain.port))}], ['#dbField-user', 'ada']]) { const n = document.querySelector(id); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); } const s = document.querySelector('#dbField-ssl'); s.value = 'require'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const ko = await test(b);
    check(/SSL 모드를 끄기로/.test(ko), `the failure is in Korean and names the setting (${ko})`);
    check(b.consoleErrors.length === 0, 'no renderer exceptions in the Korean session');
  } finally { b.close(); }
} catch (err) {
  check(false, err.stack || err.message);
  a?.close();
}
for (const s of [pgPlain, pgTls, myPlain, myTls]) s.close();
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
