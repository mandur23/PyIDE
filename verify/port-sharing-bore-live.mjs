// Port sharing of a game server against the real bore and bore.pub (opt-in, not in CI: it opens a public tunnel).
// Installs the pinned bore into a temporary install root through the Install Manager's own code (size and sha256
// checked), starts a stand-in Minecraft server from the IDE (verify/fixtures/port-sharing/mcping.py: the Java
// Edition server list ping, which a Minecraft client sends to list a server), lets the Ports window tell it is TCP,
// shares it, and pings the public bore.pub:<port> address from this computer the way a client does. Then it stops
// sharing and checks the tunnel is gone. Only the stand-in's status reply is exposed, for about a minute.
// Port 9784 for the IDE, 25599 for the server.
import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, processSnapshot } from './lib.mjs';

const q = JSON.stringify;
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), 'pyide-bore-root-'));
const mcping = path.join(repo, 'verify', 'fixtures', 'port-sharing', 'mcping.py');
const PORT = 25599;
const boreProcs = () => processSnapshot().filter((p) => /^bore(\.exe)?$/i.test(p.name) && (p.cmd || '').includes(String(PORT)));
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 30000 },
  (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))));

const { createToolchains } = require(path.join(repo, 'main', 'installer', 'toolchains.js'));
await createToolchains({ root }).install('bore', { log: () => {}, progress: () => {}, exec: (cmd, args) => run(cmd, args) });

const a = await launch({ fixture: 'core', port: 9784, name: 'port-sharing-bore-live', env: { PYIDE_INSTALL_ROOT: root } });
const { js, until, check } = a;
try {
  check(await js(`ide.ports.state().bore`), 'the pinned bore installs from its release archive (size and sha256 checked)');
  await js(`ide.api.invoke('project:exec', 'py', ['-3', '-I', ${q(mcping)}, 'serve', '${PORT}'], ide.root)`);
  await until(`ide.ports.state().ports.some((p) => p.port === ${PORT})`, 'server listed', 30000);
  await js(`(ide.toolWindows.get('Ports').show(), true)`);
  await until(`ide.ports.state().ports.find((p) => p.port === ${PORT})?.proto`, 'probed', 20000);
  check(await js(`ide.ports.state().ports.find((p) => p.port === ${PORT}).proto`) === 'tcp', 'the Minecraft server is told apart as TCP');
  await js(`(ide.settings.set('ports.confirmShare', false), ide.ports.share(${PORT}), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === ${PORT} && t.state !== 'starting')`, 'tunnel up', 60000)
    .catch(async (err) => { console.log(`state: ${q(await js('ide.ports.state()')).slice(0, 2500)}`); throw err; });
  const t = await js(`ide.ports.state().tunnels.find((t) => t.port === ${PORT})`);
  check(t.state === 'shared' && t.kind === 'bore' && /^bore\.pub:\d+$/.test(t.url || ''), `bore gives the server a public address (${q(t)})`);
  const [host, port] = t.url.split(':');
  let answer = null;
  const started = Date.now();
  for (let i = 0; i < 10 && !answer?.startsWith('{'); i++) {
    answer = await run('py', ['-3', '-I', mcping, 'ping', host, port]).catch((e) => `error ${e.message}`);
    if (!answer.startsWith('{')) await new Promise((r) => setTimeout(r, 2000));
  }
  const reply = answer.startsWith('{') ? JSON.parse(answer) : null;
  check(reply?.motd === 'PyIDE bore test server' && reply.version === '1.20.1',
    `a Minecraft status ping to ${t.url} reaches the server (${Math.round((Date.now() - started) / 1000)} s; ${String(answer).trim().slice(0, 160)})`);
  await js(`ide.ports.unshare(${PORT})`);
  await new Promise((r) => setTimeout(r, 2000));
  check(!(await js('ide.ports.state().tunnels.length')) && !boreProcs().length, 'Stop Sharing ends the tunnel and its process');
} catch (err) {
  check(false, err.message);
}
a.close();
await new Promise((r) => setTimeout(r, 1500));
check(!boreProcs().length, 'no bore is left running');
rmSync(root, { recursive: true, force: true });
const failed = a.results.filter((r) => !r.ok).length;
console.log(`${a.results.length - failed}/${a.results.length} passed`);
process.exit(failed ? 1 : 0);
