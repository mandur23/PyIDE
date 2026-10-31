// Ports tool window and port sharing (renderer/features/port-sharing, main/features/port-sharing.js) with a stand-in
// for cloudflared that prints a quick tunnel's banner: a server started from the IDE is listed and announced and one
// started elsewhere is not; Share warns first (Don't ask again sticks), shows the public address and copies it; Stop
// Sharing and the server stopping end the tunnel; a server that is not a web server (TCP) is shared through a stand-in
// for bore with a host:port address, an https server through cloudflared without a certificate check, and a server
// started elsewhere is listed once its port is added; a server on every interface shows its LAN address; automatic
// sharing asks before it turns on and then shares a new server by itself; without cloudflared, Share offers the
// Install Manager download; the window in Korean.
// Ports 9782-9783 for the IDE; the servers listen on 18631-18639.
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { networkInterfaces } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
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
// As the real one does, a long connectivity report comes between the address and the registration.
setTimeout(() => process.stderr.write('INF precheck: DNS, UDP and TCP connectivity pass '.repeat(120) + '\\n'), 450);
setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0 location=icn01 protocol=quic\\n'), 600);
setInterval(() => {}, 1000);
`);
const fakeBore = path.join(work, 'fake-bore.cjs');
const boreLog = path.join(work, 'bore-args.txt');
// bore colours its log; the address line is what matters.
writeFileSync(fakeBore, `const fs = require('fs');
fs.appendFileSync(${q(boreLog)}, process.argv.slice(2).join(' ') + '\\n');
setTimeout(() => process.stdout.write('\\x1b[32m INFO\\x1b[0m \\x1b[2mbore_cli::client\\x1b[0m: connected to server \\x1b[3mremote_port\\x1b[0m=40123\\n'
  + '\\x1b[32m INFO\\x1b[0m \\x1b[2mbore_cli::client\\x1b[0m: listening at bore.pub:40123\\n'), 300);
setInterval(() => {}, 1000);
`);
const env = { PYIDE_CLOUDFLARED: q([process.execPath, fake]), PYIDE_BORE: q([process.execPath, fakeBore]), PYIDE_INSTALL_ROOT: path.join(work, 'root') };
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'port-sharing');
// A game-server-like TCP server: it reads a request and closes, never answering HTTP.
const tcpCode = (port, host = '127.0.0.1') => `require('net').createServer((s) => { s.on('data', () => s.destroy()); s.on('error', () => {}); }).listen(${port}, '${host}')`;
// A development https server with a self-signed certificate.
const httpsCode = (port) => `require('https').createServer({ key: require('fs').readFileSync(${q(path.join(fixtures, 'localhost-key.pem'))}),
  cert: require('fs').readFileSync(${q(path.join(fixtures, 'localhost-cert.pem'))}) }, (q, r) => r.end('secure')).listen(${port}, '127.0.0.1')`;
const lanIps = Object.values(networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)).map((i) => i.address);
const serverCode = (port) => `require('http').createServer((q, r) => r.end('hello ${port}')).listen(${port}, '127.0.0.1')`;
const fakeTunnels = () => processSnapshot().filter((p) => /fake-(cloudflared|bore)\.cjs/.test(p.cmd || ''));

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
  // A server that accepts one client must not lose it to a probe nobody asked for.
  const connections = path.join(work, 'connections.txt');
  writeFileSync(connections, '');
  const counted = await js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(`require('net').createServer((s) => { require('fs').appendFileSync(${q(connections)}, 'c'); s.on('error', () => {}); s.on('data', () => s.destroy()); }).listen(18639, '127.0.0.1')`)}], ide.root)`);
  await until(`ide.ports.state().ports.some((p) => p.port === 18639)`, 'counted server listed', 30000);
  await new Promise((r) => setTimeout(r, 4000));
  check(readFileSync(connections, 'utf8') === '' && await js(`ide.ports.state().ports.every((p) => p.proto === null)`),
    'while the Ports window is closed, no server is probed (no connection reaches it)');

  await js(`(ide.toolWindows.get('Ports').show(), true)`);
  await until(`ide.ports.state().ports.find((p) => p.port === 18631)?.proto === 'http'`, 'probed once shown', 15000)
    .then(() => check(true, 'with the Ports window shown, servers are probed'), () => check(false, 'with the Ports window shown, servers are probed'));
  await js(`ide.proc.kill(${counted})`);
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

  const startCode = (code) => js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(code)}], ide.root)`);
  const tcp = await startCode(tcpCode(18635, '0.0.0.0'));
  await until(`ide.ports.state().ports.some((p) => p.port === 18635 && p.proto)`, 'tcp server probed', 30000);
  const tcpRow = await js(`ide.ports.state().ports.find((p) => p.port === 18635)`);
  check(tcpRow.proto === 'tcp', `a server that does not answer HTTP is told apart as TCP (${tcpRow.proto})`);
  await until(`document.querySelector('#portsList .ports-row[data-port="18635"] .ports-local')?.dataset.url === 'localhost:18635'`, 'tcp local address', 10000)
    .then(() => check(true, 'its local address is host:port, not an http link'), () => check(false, 'its local address is host:port'));
  const lanShown = await js(`[...document.querySelectorAll('#portsList .ports-row[data-port="18635"] .ports-lan-url')].map((n) => n.dataset.url)`);
  check(q(lanShown) === q(lanIps.map((ip) => `${ip}:18635`)), `a server on every interface shows its LAN address (${q(lanShown)})`);
  await js(`(document.querySelector('#portsList .ports-row[data-port="18635"] .ports-share').click(), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18635 && t.state === 'shared')`, 'tcp shared', 20000);
  const tcpTunnel = await js(`ide.ports.state().tunnels.find((t) => t.port === 18635)`);
  check(tcpTunnel.kind === 'bore' && tcpTunnel.url === 'bore.pub:40123' && readFileSync(boreLog, 'utf8').includes('local 18635 --local-host 127.0.0.1 --to bore.pub'),
    `a TCP server is shared through bore and gets a host:port address (${q(tcpTunnel)})`);
  check(!readFileSync(argsLog, 'utf8').includes('18635'), 'cloudflared is not used for a TCP server');
  await until(`document.querySelector('#portsList .ports-row[data-port="18635"] .ports-url')?.textContent === 'bore.pub:40123'`, 'bore address in the row', 10000);
  check(await js(`document.querySelector('#portsList .ports-row[data-port="18635"] .ports-url').tagName`) === 'SPAN', 'the TCP address is copied on click, not opened in the browser');
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 18635 is shared') && !n.textContent.includes('Open in Browser'))`, 'tcp shared note', 10000)
    .then(() => check(true, 'its address is announced without Open in Browser'), () => check(false, 'the TCP address is announced without Open in Browser'));
  await a.shot('ports-tcp.png');
  await js(`ide.proc.kill(${tcp})`);
  await until(`!ide.ports.state().tunnels.length`, 'tcp gone', 20000);

  const secure = await startCode(httpsCode(18636));
  await until(`ide.ports.state().ports.some((p) => p.port === 18636 && p.proto)`, 'https server probed', 30000);
  check(await js(`ide.ports.state().ports.find((p) => p.port === 18636).proto`) === 'https', 'an https server is told apart');
  check(await js(`document.querySelector('#portsList .ports-row[data-port="18636"] .ports-local')?.dataset.url`) === 'https://localhost:18636/', 'its local address is https');
  await js(`(document.querySelector('#portsList .ports-row[data-port="18636"] .ports-share').click(), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18636 && t.state === 'shared')`, 'https shared', 20000);
  check(readFileSync(argsLog, 'utf8').includes('--url https://localhost:18636 --no-tls-verify'), 'cloudflared reaches it over https without checking its self-signed certificate');
  await js(`ide.proc.kill(${secure})`);
  await until(`!ide.ports.state().tunnels.length && !ide.ports.state().ports.some((p) => p.port === 18636)`, 'https gone', 20000);

  // A dev server on [::1] alone (Vite, Node 17+ on Windows) refuses 127.0.0.1.
  const v6 = await startCode(`require('http').createServer((q, r) => r.end('v6')).listen(18638, '::1')`);
  await until(`ide.ports.state().ports.some((p) => p.port === 18638 && p.proto)`, 'v6 server probed', 30000);
  check(await js(`ide.ports.state().ports.find((p) => p.port === 18638).proto`) === 'http'
    && await js(`document.querySelector('#portsList .ports-row[data-port="18638"] .ports-local')?.dataset.url`) === 'http://[::1]:18638/',
  'a server on [::1] only is probed on ::1, found to be HTTP, and its address is http://[::1]');
  await js(`(document.querySelector('#portsList .ports-row[data-port="18638"] .ports-share').click(), true)`);
  await until(`ide.ports.state().tunnels.some((t) => t.port === 18638 && t.state === 'shared')`, 'v6 shared', 20000);
  check(readFileSync(argsLog, 'utf8').includes('--url http://[::1]:18638'), 'cloudflared is pointed at [::1]');
  await js(`ide.proc.kill(${v6})`);
  await until(`!ide.ports.state().tunnels.length && !ide.ports.state().ports.some((p) => p.port === 18638)`, 'v6 gone', 20000);

  await js(`ide.ports.addPort(18632)`);
  await until(`ide.ports.state().ports.some((p) => p.port === 18632 && p.added)`, 'added port listed', 20000);
  check(true, 'a server started elsewhere is listed once its port is added');
  check(await js(`!!document.querySelector('#portsList .ports-row[data-port="18632"] .ports-remove')`) && await js(`ide.settings.get('ports.added').includes(18632)`), 'an added port is kept and can be removed');
  await js(`ide.ports.addPort(18637)`);
  await until(`!!document.querySelector('#portsList .ports-row.ports-waiting[data-port="18637"]')`, 'waiting row', 10000);
  check(true, 'an added port nothing listens on yet waits in the list');
  await js(`ide.ports.removePort(18637).then(() => ide.ports.removePort(18632))`);
  await until(`!ide.ports.state().ports.some((p) => p.port === 18632) && !document.querySelector('#portsList .ports-row[data-port="18637"]')`, 'removed', 20000);
  check(true, 'removing an added port takes it off the list');

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
// A bore.exe that is no program, as Windows sees one Smart App Control or an antivirus blocks.
mkdirSync(path.join(work, 'empty', 'bore', 'bore-0.6.0'), { recursive: true });
writeFileSync(path.join(work, 'empty', 'bore', 'bore-0.6.0', 'bore.exe'), 'not a program');
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
  k.check(await k.js(`!!(ide.installables || []).find((i) => i.id === 'tool:cloudflared') && !!(ide.installables || []).find((i) => i.id === 'tool:bore')`), 'cloudflared and bore are Install Manager items');
  await k.js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '취소').click()`);
  await k.js(`ide.api.invoke('project:exec', ${q(process.execPath)}, ['-e', ${q(tcpCode(18636))}], ide.root)`);
  await k.until(`ide.ports.state().ports.some((p) => p.port === 18636)`, 'ko tcp server listed', 30000);
  await k.until(`!!document.querySelector('#portsList .ports-row[data-port="18636"] .ports-share')`, 'ko tcp row');
  await k.js(`(document.querySelector('#portsList .ports-row[data-port="18636"] .ports-share').click(), true)`);
  await k.until(`!!document.querySelector('#portsDontAsk')`, 'ko tcp warning');
  await k.js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '공유').click()`);
  await k.until(`[...document.querySelectorAll('.ide-balloon')].some((b) => b.textContent.includes('Windows가 bore.exe를 실행하지 않았습니다') && b.textContent.includes('다시 설치'))`, 'blocked bore', 20000)
    .then(() => k.check(true, 'a bore.exe Windows will not start (spawn UNKNOWN) is explained, with Install Again'),
      async () => k.check(false, `blocked bore: ${await k.js(`[...document.querySelectorAll('.ide-balloon')].map((b) => b.textContent).join(' | ')`)}`));
  k.check(await k.js(`!ide.ports.state().tunnels.some((t) => t.port === 18636) && !!document.querySelector('#portsList .ports-row[data-port="18636"] .ports-share')`),
    'the port is not left "starting": Share is offered again');
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) a.results.push(r);
k.close();
outside.kill();
const failed = a.results.filter((r) => !r.ok).length;
console.log(`${a.results.length - failed}/${a.results.length} passed`);
process.exit(failed ? 1 : 0);
