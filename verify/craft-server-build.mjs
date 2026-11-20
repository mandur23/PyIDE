// A newer build of the server a folder runs (main/features/minecraft.js buildCheck, buildUpdate, buildRevert), in a
// Korean craft window against a stand-in of Paper's downloads on this computer. No real server, game, launcher, EULA
// or network: the "jars" are bytes this test writes.
// Checks: a server on the newest build has no notice; when a newer one is published the card says so and its More
// menu offers the update; the update asks first, downloads the new file checked against its sha256, keeps the old one
// as server.jar.old and writes the build; a file that does not match its checksum changes nothing; Back to Build puts
// the old file and build back; a server of a kind without builds (Fabric) is never asked about. Port 9752.
// Usage: node verify/craft-server-build.mjs
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { craftHas, launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-build-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OLD = Buffer.from('paper build 100 (a stand-in, not a jar)');
const NEW = Buffer.from('paper build 120 (a stand-in, not a jar), a little longer');
const dir = path.join(project, 'servers', 'town');
write(path.join(dir, 'pyide-server.json'), S({ kind: 'paper', mc: '1.21.4', loader: null, build: 100, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(dir, 'server.properties'), 'server-port=25751\nmotd=town\n');
write(path.join(dir, 'server.jar'), OLD);
const modded = path.join(project, 'servers', 'modded');
write(path.join(modded, 'pyide-server.json'), S({ kind: 'fabric', mc: '1.21.4', loader: '0.16.0', build: null, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(modded, 'server.properties'), 'server-port=25752\n');
const desc = () => JSON.parse(readFileSync(path.join(dir, 'pyide-server.json'), 'utf8'));
const jar = (name = 'server.jar') => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name)) : null);

// The stand-in of Paper's Fill API: what it publishes is `published`, changed as the test goes on.
let published = { id: 100, file: OLD, sum: sha256(OLD) };
const asked = [];
const server = http.createServer((q, r) => {
  asked.push(q.url);
  if (q.url === '/paper/versions/1.21.4/builds') {
    r.writeHead(200, { 'content-type': 'application/json' });
    return r.end(S([{ id: 90, channel: 'STABLE', downloads: {} }, { id: published.id, channel: 'STABLE', downloads: { 'server:default': { url: `${base}/files/paper-${published.id}.jar`, size: published.file.length, checksums: { sha256: published.sum } } } }]));
  }
  if (q.url === `/files/paper-${published.id}.jar`) { r.writeHead(200); return r.end(published.file); }
  r.writeHead(404);
  return r.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const CLOSED = 'http://127.0.0.1:1';
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${base}/paper`, modrinth: `${CLOSED}/modrinth` }) };

const t = await launch({ name: 'craft-server-build', port: 9752, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, sleep } = t;
const card = (name) => `document.querySelector('#minecraftScreen .mc-server[data-name="${name}"]')`;
const chip = `${card('town')}?.querySelector('.mc-build-chip')`;
const dialogButton = (label) => `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
const titles = () => js(`ide.notifications.list().map((e) => e.title)`);
const answer = async (label, what) => {
  await until(`!!(${dialogButton(label)})`, what, 8000);
  await js(`(${dialogButton(label)}).click()`);
};
try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 20000);
  await js(`(ide.minecraft.screen.show('servers'), ide.minecraft.refresh())`);
  await until(`!!${card('town')}?.offsetParent && !!${card('modded')}`, 'the cards', 10000);
  await until(`!!ide.minecraft.buildAt(ide.minecraft.servers().find((s) => s.name === 'town').dir)`, 'the first check of the build', 10000);
  const first = await js(`({ chip: !!${chip}, build: ide.minecraft.buildAt(ide.minecraft.servers().find((s) => s.name === 'town').dir), update: ${craftHas(card('town'), 'mc-build-update')},
    fabric: ide.minecraft.buildAt(ide.minecraft.servers().find((s) => s.name === 'modded').dir) })`);
  check(!first.chip && !first.update && first.build.latest === 100 && !first.build.newer && first.fabric === null && !asked.some((u) => /fabric/.test(u)),
    `a server on the newest build has no notice, and a Fabric server is not asked about (${S(first)})`);
  const calls = asked.length;
  await js(`ide.minecraft.refresh()`);
  await sleep(600);
  check(asked.length === calls, `reading the list again does not ask Paper again within six hours (${asked.length - calls} more requests)`);

  // ---------- a newer build is published ----------
  published = { id: 120, file: NEW, sum: sha256(NEW) };
  await js(`ide.minecraft.checkBuilds(true)`);
  await until(`!!${chip}`, 'the notice of the newer build', 10000);
  const seen = await js(`({ chip: ${chip}.textContent, tip: ${chip}.title, more: ${craftHas(card('town'), 'mc-build-update')} })`);
  check(seen.chip === '새 빌드 120' && /Paper 1\.21\.4에 이 서버의 빌드 100보다 새 빌드가 있어요/.test(seen.tip) && seen.more, `the card says a newer build is there, and its More menu has the update (${S(seen)})`);
  await shot('build-available.png');

  // ---------- a download that does not match its checksum ----------
  published = { id: 120, file: NEW, sum: sha256(Buffer.from('another file')) };
  await js(`(${chip}.click(), true)`);
  await until(`!!(${dialogButton('업데이트')})`, 'the question before the update', 8000);
  const question = await js(`document.querySelector('.dialog, .ide-dialog, [role="dialog"]')?.textContent || document.body.textContent.match(/town 서버를[^?]*\\?[^.]*\\./)?.[0] || ''`);
  check(/빌드 100 → 120/.test(question) && /백업/.test(question), `the update asks first, naming the builds and the backup (${S(question.slice(0, 160))})`);
  await answer('업데이트', 'Update');
  await until(`ide.run.sessions().some((s) => /서버 업데이트/.test(s.title || s.name || '')) || true`, 'the job', 1000);
  for (let i = 0; i < 80 && !asked.includes('/files/paper-120.jar'); i++) await sleep(100);
  await sleep(1500);
  check(jar().equals(OLD) && !jar('server.jar.new') && !jar('server.jar.old') && desc().build === 100, `a file that does not match its checksum changes nothing (build ${desc().build}, ${jar().length} bytes)`);

  // ---------- the update ----------
  published = { id: 120, file: NEW, sum: sha256(NEW) };
  await js(`ide.minecraft.refresh()`);
  await until(`!!${chip}`, 'the notice still there', 10000);
  await js(`(${chip}.click(), true)`);
  await answer('업데이트', 'Update');
  for (let i = 0; i < 100 && desc().build !== 120; i++) await sleep(100);
  const d = desc();
  check(d.build === 120 && d.previousBuild === 100 && jar().equals(NEW) && jar('server.jar.old')?.equals(OLD) && !jar('server.jar.new') && d.memory === '2G' && d.kind === 'paper',
    `Update downloads the new file, keeps the old one as server.jar.old and writes the build (${S({ build: d.build, previous: d.previousBuild, bytes: jar().length })})`);
  await until(`!${chip} && ${craftHas(card('town'), 'mc-build-revert')}`, 'the notice gone, the way back offered', 10000);
  const told = await titles();
  check(told.includes('town 서버 업데이트 완료 (빌드 120)'), `and says so (${S(told)})`);

  // ---------- back to the build before ----------
  await js(`(() => { const c = ${card('town')}; c.querySelector('.mc-more').click(); const row = document.querySelector('.mc-actions-menu .menu-item[data-act="mc-build-revert"]');
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await answer('되돌리기', 'Go Back');
  for (let i = 0; i < 60 && desc().build !== 100; i++) await sleep(100);
  const back = desc();
  check(back.build === 100 && back.previousBuild === undefined && jar().equals(OLD) && !jar('server.jar.old'), `Back to Build puts the old file and build back (${S({ build: back.build, bytes: jar().length })})`);
  await until(`!!${chip}`, 'the newer build offered again', 10000);
  check(true, 'and the newer build is offered again');
  check(!t.consoleErrors.length, `no renderer exceptions ${S(t.consoleErrors)}`);
} catch (err) {
  check(false, `craft-server-build crashed: ${err.stack || err}`);
  await shot('failure.png').catch(() => {});
}
server.close();
t.finish();
