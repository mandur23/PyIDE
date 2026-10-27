// Port sharing against the real cloudflared and Cloudflare (opt-in, not in CI: it opens a public tunnel). Installs
// the pinned cloudflared into a temporary install root through the Install Manager's own code (size and sha256
// checked), starts a server from the IDE that answers one fixed sentence, shares it, fetches the public
// https://…trycloudflare.com address from this computer, then stops sharing and checks the tunnel is gone. Only that
// sentence is exposed, for about a minute. Port 9785 for the IDE, 18641 for the server.
import { mkdtempSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, processSnapshot } from './lib.mjs';

const q = JSON.stringify;
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), 'pyide-cf-root-'));
const SENTENCE = 'pyide port sharing test';
const cloudflaredProcs = () => processSnapshot().filter((p) => /^cloudflared(\.exe)?$/i.test(p.name) && (p.cmd || '').includes('18641'));

const { createToolchains } = require(path.join(repo, 'main', 'installer', 'toolchains.js'));
await createToolchains({ root }).install('cloudflared', { log: () => {}, progress: () => {}, exec: async () => { throw new Error('no archive to extract'); } });

// cloudflared also writes its log to a file, read back if the tunnel does not come up.
const cfLog = path.join(root, 'cloudflared.log');
const exe0 = path.join(root, 'cloudflared', 'cloudflared-2026.10.0', 'cloudflared.exe');
const a = await launch({ fixture: 'core', port: 9785, name: 'port-sharing-live', env: { PYIDE_INSTALL_ROOT: root, PYIDE_CLOUDFLARED: q([exe0, '--loglevel', 'debug', '--logfile', cfLog]) } });
const { js, until, check } = a;
try {
  check(true, 'the pinned cloudflared downloads with its size and sha256');
  const code = `require('http').createServer((q, r) => r.end(${q(SENTENCE)})).listen(18641, '127.0.0.1')`;
  await js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(code)}], ide.root)`);
  await until(`ide.ports.state().ports.some((p) => p.port === 18641)`, 'server listed', 30000);
  await js(`(ide.settings.set('ports.confirmShare', false), ide.ports.share(18641), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18641 && t.state !== 'starting')`, 'tunnel up', 90000)
    .catch(async (err) => {
      console.log(`state: ${q(await js('ide.ports.state()')).slice(0, 2500)}`);
      console.log(`cloudflared processes: ${q(cloudflaredProcs().map((p) => ({ pid: p.pid, cmd: (p.cmd || '').slice(0, 200) })))}`);
      try { console.log(`cloudflared log file:
${(await import('fs')).readFileSync(cfLog, 'utf8').slice(-3000)}`); } catch (e) { console.log(`no log file: ${e.message}`); }
      console.log(`dialogs and balloons: ${q(await js(`[...document.querySelectorAll('.dialog, .ide-balloon')].map((n) => n.textContent.slice(0, 300))`))}`);
      throw err;
    });
  const t = await js(`ide.ports.state().tunnels.find((t) => t.port === 18641)`);
  check(t.state === 'shared' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(t.url || ''), `cloudflared gives the port a public address (${q(t)})`);
  let body = null;
  const started = Date.now();
  // Shared means cloudflared has registered with Cloudflare; the name may still take a moment to resolve.
  for (let i = 0; i < 60 && body !== SENTENCE; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    body = await fetch(t.url).then((r) => r.text(), (e) => `error ${e.cause?.code || e.message}`);
  }
  check(body === SENTENCE, `the public address reaches the server (${Math.round((Date.now() - started) / 1000)} s; ${q(String(body).slice(0, 80))})`);
  await js(`ide.ports.unshare(18641)`);
  await new Promise((r) => setTimeout(r, 2000));
  check(!(await js('ide.ports.state().tunnels.length')) && !cloudflaredProcs().length, 'Stop Sharing ends the tunnel and its process');
} catch (err) {
  check(false, err.message);
}
a.close();
await new Promise((r) => setTimeout(r, 1500));
check(!cloudflaredProcs().length, 'no cloudflared is left running');
rmSync(root, { recursive: true, force: true });
const failed = a.results.filter((r) => !r.ok).length;
console.log(`${a.results.length - failed}/${a.results.length} passed`);
process.exit(failed ? 1 : 0);
