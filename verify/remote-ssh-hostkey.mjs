// First-contact host keys with the real OpenSSH client: Windows' ssh.exe, started with the arguments and environment
// main/remote/session.js builds and answered by main/remote/askpass.js, against an SSH server in this process (the ssh2
// npm package, into a temp folder). No Electron: the suite gives askpass a temp folder, and known_hosts is a temp file,
// so the user's own ~/.ssh is not touched. verify/remote-interp.mjs covers the dialog with its stand-in ssh.
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const SSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
if (!existsSync(SSH)) { console.log('SKIP the Windows OpenSSH client is not installed'); process.exit(0); }

const work = mkdtempSync(path.join(tmpdir(), 'pyide-ssh-hostkey-'));
// Without its install scripts ssh2 stays pure JS: a loaded native helper would keep this folder from being deleted.
execSync(`npm install --prefix "${work}" --no-audit --no-fund --loglevel error --ignore-scripts ssh2@1`, { stdio: 'ignore', windowsHide: true });
const require = createRequire(import.meta.url);
const ssh2 = createRequire(path.join(work, 'package.json'))('ssh2');
const Module = require('module');
const realLoad = Module._load;
Module._load = (id, ...rest) => (id === 'electron' ? { app: { getPath: () => work } } : realLoad(id, ...rest));
const askpass = require('../main/remote/askpass.js');
const { session, runRaw } = require('../main/remote/session.js');

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const SECRET = 's3cret-Pw-hostkey';
const knownHosts = path.join(work, 'known_hosts');
const config = path.join(work, 'ssh_config');
writeFileSync(config, '');
const fingerprintOf = (publicKey) => `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(publicKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

function startServer(hostKey, port = 0) {
  const seen = { attempts: [] };
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      seen.attempts.push({ method: ctx.method, password: ctx.password });
      if (ctx.method === 'password' && ctx.password === SECRET) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      accept().once('exec', (acceptExec) => {
        const stream = acceptExec();
        stream.write('hello from the server\n');
        stream.exit(0);
        stream.end();
      });
    }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) })));
}

// One ssh run as the IDE starts it, with known_hosts and the configuration moved to temp files.
async function connect(port, secrets) {
  const s = session({ id: 'hostkey', kind: 'ssh', host: '127.0.0.1', port, user: 'ada', python: 'python3' });
  const { args, env, release } = s.sshArgs({ secrets });
  const extra = ['-F', config, '-o', `UserKnownHostsFile=${knownHosts.replace(/\\/g, '/')}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentityAgent=none'];
  try { return await runRaw(SSH, [...extra, ...args, 'run'], { env, timeout: 30000 }); } finally { release(); }
}

const questions = [];
let trust = false;
askpass.onHostKey(async (key) => { questions.push(key); return trust; });

const first = ssh2.utils.generateKeyPairSync('ed25519');
const server = await startServer(first.private);
const fingerprint = fingerprintOf(first.public);
try {
  const refused = await connect(server.port, { password: SECRET });
  check(questions.length === 1 && questions[0].fingerprint === fingerprint && questions[0].keyType === 'ED25519', `ssh asks about the unknown key and the question carries its real fingerprint (${JSON.stringify(questions[0])})`);
  check(/127\.0\.0\.1/.test(questions[0]?.host), `and names the host (${questions[0]?.host})`);
  check(refused.code === 255 && /Host key verification failed/.test(refused.stderr), `refusing it ends ssh (exit ${refused.code})`);
  check(!server.seen.attempts.length, `and the server got no login attempt, so no password (${JSON.stringify(server.seen.attempts)})`);
  check(!existsSync(knownHosts) || !readFileSync(knownHosts, 'utf8').trim(), 'and nothing is recorded');

  trust = true;
  questions.length = 0;
  const accepted = await connect(server.port, { password: SECRET });
  check(accepted.code === 0 && accepted.stdout.includes('hello from the server'), `trusting it connects (exit ${accepted.code}: ${accepted.stderr.slice(-200)})`);
  check(server.seen.attempts.some((a) => a.password === SECRET), 'and the stored password goes to the server only now, as a password');
  check(/ssh-ed25519/.test(readFileSync(knownHosts, 'utf8')), 'ssh recorded the key in known_hosts');

  questions.length = 0;
  server.seen.attempts.length = 0;
  const again = await connect(server.port, { password: SECRET });
  check(again.code === 0 && !questions.length, 'the next connection asks nothing');

  rmSync(knownHosts, { force: true });
  questions.length = 0;
  server.seen.attempts.length = 0;
  const keyOnly = await connect(server.port, null);
  check(questions.length === 1 && !server.seen.attempts.some((a) => a.method === 'password'), `a target with no saved secrets still gets the question, and no password prompt (exit ${keyOnly.code}: ${keyOnly.stderr.slice(-120)})`);

  await server.close();
  const second = ssh2.utils.generateKeyPairSync('ed25519');
  const impostor = await startServer(second.private, server.port);
  questions.length = 0;
  const changed = await connect(impostor.port, { password: SECRET });
  check(changed.code === 255 && /REMOTE HOST IDENTIFICATION HAS CHANGED/.test(changed.stderr), `a different key on the same host and port is refused (exit ${changed.code})`);
  check(!questions.length && !impostor.seen.attempts.length, 'without a question and without a login attempt');
  await impostor.close();
} catch (err) {
  check(false, err.stack || err.message);
}
Module._load = realLoad;
rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
