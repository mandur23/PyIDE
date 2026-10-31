// SSH passwords and key passphrases for remote interpreters. Secrets are encrypted with safeStorage in
// <userData>/remote-interp/secrets.json and never reach the renderer or the settings file. ssh.exe asks for them
// through SSH_ASKPASS: the IDE's own executable run as Node with a --require'd script that reads the answer from a
// named pipe this process serves, keyed by a one-time token per ssh invocation. ssh asks about a host key it has not
// seen the same way, before any secret is used: that question goes to the user, and ssh itself records the key.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const dir = () => path.join(require('electron').app.getPath('userData'), 'remote-interp');
const file = () => path.join(dir(), 'secrets.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}
function save(all) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}
function encrypt(text) {
  const { safeStorage } = require('electron');
  return safeStorage.isEncryptionAvailable()
    ? { enc: 'safeStorage', data: safeStorage.encryptString(text).toString('base64') }
    : { enc: 'plain', data: Buffer.from(text, 'utf8').toString('base64') };
}
function decrypt(secret) {
  if (!secret) return undefined;
  const buf = Buffer.from(secret.data, 'base64');
  return secret.enc === 'safeStorage' ? require('electron').safeStorage.decryptString(buf) : buf.toString('utf8');
}

// kind: 'password' | 'passphrase'; an empty value removes it.
function setSecret(id, kind, value) {
  const all = load();
  const entry = { ...(all[id] || {}) };
  if (value) entry[kind] = encrypt(value);
  else delete entry[kind];
  if (Object.keys(entry).length) all[id] = entry;
  else delete all[id];
  save(all);
}
const secretsOf = (id) => {
  const e = load()[id] || {};
  return { password: decrypt(e.password), passphrase: decrypt(e.passphrase) };
};
const hasSecrets = (id) => {
  const e = load()[id] || {};
  return { password: !!e.password, passphrase: !!e.passphrase };
};
const forget = (id) => { const all = load(); delete all[id]; save(all); };

const ASKPASS_JS = `// Written by Nano Studio: answers one ssh prompt from the IDE's named pipe, then exits before Node runs argv[1].
// Node has already rewritten process.argv[1] as a file path, which would change a fingerprint's slashes: the diagnostic
// report keeps the command line as it came.
const fs = require('fs');
try {
  process.report.excludeNetwork = true;
  const prompt = process.report.getReport().header.commandLine.pop() || '';
  const fd = fs.openSync(process.env.PYIDE_ASKPASS_PIPE, 'r+');
  fs.writeSync(fd, process.env.PYIDE_ASKPASS_TOKEN + '\\n' + JSON.stringify(prompt) + '\\n');
  const chunks = [];
  const buf = Buffer.alloc(4096);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) chunks.push(Buffer.from(buf.subarray(0, n)));
  fs.closeSync(fd);
  const answer = Buffer.concat(chunks).toString('utf8');
  if (!answer) process.exit(1);
  process.stdout.write(answer + '\\n');
  process.exit(0);
} catch {
  process.exit(1);
}
`;

let server = null;
let pipe = null;
const tokens = new Map(); // token -> {password, passphrase}

// fn({host, keyType, fingerprint}) -> Promise<boolean>: whether the user trusts a host key ssh has not seen.
let trustHostKey = async () => false;
const onHostKey = (fn) => { trustHostKey = fn; };

// ssh's question, as OpenSSH words it. A yes/no question this cannot read is refused: a stored password must never be
// the answer to one.
async function answerHostKey(prompt) {
  const host = /^The authenticity of host '([^']*)'/m.exec(prompt)?.[1];
  const key = /^(\S+) key fingerprint is (\S+?)\.?\s*$/m.exec(prompt);
  return host && key && await trustHostKey({ host, keyType: key[1], fingerprint: key[2] }) ? 'yes' : 'no';
}

function ensureServer() {
  if (server) return;
  pipe = `\\\\.\\pipe\\pyide-askpass-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  server = net.createServer((sock) => {
    let buf = '';
    let asked = false;
    sock.on('data', async (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      if (lines.length < 3 || asked) return;
      asked = true;
      const s = tokens.get(lines[0].trim());
      const prompt = s ? JSON.parse(lines[1]) : '';
      const answer = !s ? '' : /\byes\b[^\n]*\bno\b[^\n]*$/i.test(prompt) ? await answerHostKey(prompt)
        : /passphrase/i.test(prompt) ? s.passphrase || '' : s.password || '';
      sock.end(answer);
    });
    sock.on('error', () => {});
  });
  server.on('error', () => {});
  server.listen(pipe);
  server.unref();
}

// Environment that lets one ssh invocation ask about a host key and for the target's secrets (override: unsaved ones
// from a form). hasSecrets says whether there are any to ask for. release() forgets the token.
function sshEnv(id, override) {
  const s = override || secretsOf(id);
  ensureServer();
  fs.mkdirSync(dir(), { recursive: true });
  const script = path.join(dir(), 'askpass.js');
  if (!fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== ASKPASS_JS) fs.writeFileSync(script, ASKPASS_JS);
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, s);
  return {
    hasSecrets: !!(s.password || s.passphrase),
    env: {
      SSH_ASKPASS: process.execPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'pyide:0',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--require "${script.replace(/\\/g, '/')}"`,
      PYIDE_ASKPASS_PIPE: pipe,
      PYIDE_ASKPASS_TOKEN: token,
    },
    release: () => tokens.delete(token),
  };
}

module.exports = { setSecret, hasSecrets, forget, sshEnv, onHostKey };
