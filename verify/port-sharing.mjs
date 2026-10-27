// Ports tool window and port sharing (renderer/features/port-sharing, main/features/port-sharing.js) with a stand-in
// for cloudflared that prints a quick tunnel's banner: a server started from the IDE is listed and announced and one
// started elsewhere is not; Share warns first (Don't ask again sticks), shows the public address and copies it; Stop
// Sharing and the server stopping end the tunnel; automatic sharing asks before it turns on and then shares a new
// server by itself; without cloudflared, Share offers the Install Manager download; the window in Korean.
// Ports 9782-9783 for the IDE; the servers listen on 18631-18634.
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, processSnapshot } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-ports-'));
const fake = path.join(work, 'fake-cloudflared.cjs');
const argsLog = path.join(work, 'args.txt');
writeFileSync(fake, `const fs = require('fs');
fs.appendFileSync(${q(argsLog)}, process.argv.slice(2).join(' ') + '\\n');
const port = (process.argv.join(' ').match(/localhost:(\\d+)/) || [])[1];
setTimeout(() => process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n'
  + 'INF +--------------------------------------------------------------------------------------------+\\n'
  + 'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\\n'
  + 'INF |  https://fake-port-' + port + '.trycloudflare.com                                           |\\n'), 300);
setInterval(() => {}, 1000);
`);
const env = { PYIDE_CLOUDFLARED: q([process.execPath, fake]), PYIDE_INSTALL_ROOT: path.join(work, 'root') };
const serverCode = (port) => `require('http').createServer((q, r) => r.end('hello ${port}')).listen(${port}, '127.0.0.1')`;
const fakeTunnels = () => processSnapshot().filter((p) => (p.cmd || '').includes('fake-cloudflared.cjs'));

const a = await launch({ fixture: 'core', port: 9782, name: 'port-sharing', env });
const { js, until, check, click } = a;
const outside = spawn(process.execPath, ['-e', serverCode(18632)], { stdio: 'ignore', windowsHide: true });
try {
  const startServer = (port) => js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(serverCode(port))}], ide.root)`);
  const s1 = await startServer(18631);
  await until(`ide.ports.state().ports.some((p) => p.port === 18631)`, 'IDE server listed', 30000);
  const st = await js('ide.ports.state()');
  check(st.ports.some((p) => p.port === 18631 && /node/i.test(p.name)) && !st.ports.some((p) => p.port === 18632),
    `a server started from the IDE is listed, one started elsewhere is not (${q(st.ports.map((p) => p.port))})`);
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 18631 is available'))`, 'announced', 10000)
    .then(() => check(true, 'a new server is announced with Open in Browser and Share'), () => check(false, 'a new server is announced'));

  await js(`(ide.toolWindows.get('Ports').show(), true)`);
  await until(`!!document.querySelector('#portsList .ports-row[data-port="18631"]')`, 'row');
  check(await js(`document.querySelector('#portsList .ports-row[data-port="18631"] .ports-local').dataset.url`) === 'http://localhost:18631/', 'the row has the local address');
  await a.shot('ports.png');

  await js(`(document.querySelector('#portsList .ports-row[data-port="18631"] .ports-share').click(), true)`);
  await until(`!!document.querySelector('#portsDontAsk')`, 'warning');
  check(/Anyone with the public address can open the server on port 18631/.test(await js(`document.querySelector('.ports-warning').textContent`)), 'sharing warns that anyone with the address reaches the server');
  await js(`(document.querySelector('#portsDontAsk').click(), [...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Share').click(), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18631 && t.state === 'shared')`, 'shared', 20000);
  const url = await js(`ide.ports.state().tunnels.find((t) => t.port === 18631).url`);
  check(url === 'https://fake-port-18631.trycloudflare.com' && readFileSync(argsLog, 'utf8').includes('tunnel --no-autoupdate --url http://localhost:18631'),
    `cloudflared runs a quick tunnel to the port and its address is shown (${url})`);
  await until(`document.querySelector('#portsList .ports-row[data-port="18631"] .ports-url')?.dataset.url === ${q(url)}`, 'url in the row');
  check(true, 'the row shows the public address');
  await js(`(document.querySelector('#portsList .ports-row[data-port="18631"] .ports-copy').click(), true)`);
  check(await until(`navigator.clipboard.readText().then((t) => t === ${q(url)}).catch(() => false)`, 'copied', 5000).then(() => true, () => false)
    || await js(`ide.api.invoke('clipboard:readText').then((t) => t === ${q(url)}).catch(() => false)`), 'the copy button copies the address');
  await a.shot('shared.png');

  await js(`(document.querySelector('#portsList .ports-row[data-port="18631"] .ports-stop').click(), true)`);
  await until(`!ide.ports.state().tunnels.length`, 'unshared');
  await until(`true`, 'settle');
  await new Promise((r) => setTimeout(r, 1500));
  check(!fakeTunnels().length, 'Stop Sharing ends the tunnel process');

  await js(`(document.querySelector('#portsList .ports-row[data-port="18631"] .ports-share').click(), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18631 && t.state === 'shared')`, 'shared again without asking', 20000);
  check(!(await js(`!!document.querySelector('#portsDontAsk')`)), "after Don't ask again, Share shares at once");
  await js(`ide.proc.kill(${s1})`);
  await until(`!ide.ports.state().ports.some((p) => p.port === 18631) && !ide.ports.state().tunnels.length`, 'server gone', 20000);
  await new Promise((r) => setTimeout(r, 1500));
  check(!fakeTunnels().length, 'when the server stops, its row and its tunnel go too');

  await js(`(document.querySelector('#portsAuto').click(), true)`);
  await until(`[...document.querySelectorAll('.dialog')].some((d) => d.textContent.includes('Share New Ports Automatically'))`, 'auto warning');
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Turn On').click()`);
  check(await js(`ide.settings.get('ports.autoShare') === true && document.querySelector('#portsAuto').checked`), 'automatic sharing asks first and then turns on');
  await startServer(18633);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18633 && t.state === 'shared')`, 'auto shared', 30000);
  check(true, 'with automatic sharing a new server gets a public address by itself');
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 18633 is shared'))`, 'shared note', 10000)
    .then(() => check(true, 'the public address is announced with Copy Address'), () => check(false, 'the public address is announced'));
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${q(a.consoleErrors)}` : ''}`);
  const internal = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${q(internal).slice(0, 800)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
a.close();
await new Promise((r) => setTimeout(r, 1500));
check(!fakeTunnels().length, 'quitting the IDE ends every tunnel');

// Without cloudflared, and in Korean.
const k = await launch({ fixture: 'core', port: 9783, name: 'port-sharing-ko', lang: 'ko-KR', env: { PYIDE_INSTALL_ROOT: path.join(work, 'empty') } });
try {
  await k.js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(serverCode(18634))}], ide.root)`);
  await k.until(`ide.ports.state().ports.some((p) => p.port === 18634)`, 'ko server listed', 30000);
  await k.js(`(ide.toolWindows.get('Ports').show(), true)`);
  await k.until(`!!document.querySelector('#portsList .ports-row[data-port="18634"]')`, 'ko row');
  const leaks = await englishLeaks(k, '#portsTool', ['node', 'PyIDE']);
  k.check(!leaks.length, `the Ports window is Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
  await k.js(`(document.querySelector('#portsList .ports-row[data-port="18634"] .ports-share').click(), true)`);
  await k.until(`!!document.querySelector('#portsDontAsk')`, 'ko warning');
  await k.js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '공유').click()`);
  await k.until(`[...document.querySelectorAll('.dialog')].some((d) => /cloudflared 2026\\.10\\.0\\(\\d+MB\\)/.test(d.textContent))`, 'download offer', 10000);
  k.check(true, 'without cloudflared, Share offers the Install Manager download (with its version and size)');
  await k.shot('ports-ko.png');
  k.check(await k.js(`!!(ide.installables || []).find((i) => i.id === 'tool:cloudflared')`), 'cloudflared is an Install Manager item');
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) a.results.push(r);
k.close();
outside.kill();
const failed = a.results.filter((r) => !r.ok).length;
console.log(`${a.results.length - failed}/${a.results.length} passed`);
process.exit(failed ? 1 : 0);
