// The lists the app keeps in its user data folder and writes whole (trusted-projects.json, project-roots.json) survive a
// failed read: a file that cannot be read now (locked) is not written over and gets what was set meanwhile once it
// reads again, a broken one is kept as .bak, and one saved with a byte order mark is read. Plain Node, no window.
// Usage: node verify/json-stores.mjs
import fs from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const work = fs.mkdtempSync(path.join(tmpdir(), 'pyide-json-stores-'));
const fresh = (name) => {
  const file = require.resolve(path.join(ROOT, 'main', name));
  delete require.cache[file];
  return require(file);
};
const realRead = fs.readFileSync;
const text = (file) => realRead(file, 'utf8');
const read = (file) => JSON.parse(text(file));
// Reads of `file` fail as a virus scanner's lock makes them fail, until unlock().
function lock(file) {
  fs.readFileSync = function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(file)) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  };
  return () => { fs.readFileSync = realRead; };
}

// ---------- trusted-projects.json ----------
{
  const data = path.join(work, 'trust-locked');
  fs.mkdirSync(data);
  const file = path.join(data, 'trusted-projects.json');
  fs.writeFileSync(file, q(['c:\\work\\old-a', 'c:\\work\\old-b']));
  const trust = fresh('trust.js');
  const unlock = lock(file);
  trust.register({ ipcMain: { handle() {} }, app: { getPath: () => data } });
  trust.trust('C:\\work\\new');
  check(q(read(file)) === q(['c:\\work\\old-a', 'c:\\work\\old-b']), `trusting a folder while the list cannot be read leaves the file as it was (${text(file)})`);
  check(trust.isTrusted('C:\\work\\new') && !trust.isTrusted('C:\\work\\old-a'), 'the folder is trusted for this session, and nothing unread is');
  unlock();
  trust.trust('C:\\work\\later');
  check(q(read(file).sort()) === q(['c:\\work\\later', 'c:\\work\\new', 'c:\\work\\old-a', 'c:\\work\\old-b']),
    `the next trust once it reads again keeps every folder in the file and both new ones (${text(file)})`);
}
{
  const data = path.join(work, 'trust-broken');
  fs.mkdirSync(data);
  const file = path.join(data, 'trusted-projects.json');
  const broken = '["c:\\\\work\\\\old-a", "c:\\\\wo';
  fs.writeFileSync(file, broken);
  const trust = fresh('trust.js');
  trust.register({ ipcMain: { handle() {} }, app: { getPath: () => data } });
  check(!trust.isTrusted('C:\\work\\old-a'), 'a broken list trusts nothing');
  trust.trust('C:\\work\\new');
  check(fs.existsSync(`${file}.bak`) && text(`${file}.bak`) === broken && q(read(file)) === q(['c:\\work\\new']),
    'a broken list is kept as trusted-projects.json.bak before the next trust writes a new one');
}
{
  const data = path.join(work, 'trust-bom');
  fs.mkdirSync(data);
  const file = path.join(data, 'trusted-projects.json');
  fs.writeFileSync(file, `\ufeff${q(['c:\\work\\old-a'])}`);
  const trust = fresh('trust.js');
  trust.register({ ipcMain: { handle() {} }, app: { getPath: () => data } });
  trust.trust('C:\\work\\new');
  check(trust.isTrusted('C:\\work\\old-a') && q(read(file).sort()) === q(['c:\\work\\new', 'c:\\work\\old-a']), 'a list saved with a byte order mark (Notepad, PowerShell 5) is read and kept');
}

// ---------- project-roots.json ----------
{
  const data = path.join(work, 'roots-locked');
  fs.mkdirSync(data);
  process.env.PYIDE_USER_DATA = data;
  const file = path.join(data, 'project-roots.json');
  const old = { 'c:\\work\\old': { sources: ['lib'], tests: [], excluded: ['build'] } };
  fs.writeFileSync(file, q(old));
  const roots = fresh('project-roots.js');
  const unlock = lock(file);
  roots.mark('C:\\work\\new', 'C:\\work\\new\\src', 'sources');
  check(q(read(file)) === q(old), `marking a folder while project-roots.json cannot be read leaves the file as it was (${text(file)})`);
  check(q(roots.rootsOf('C:\\work\\new').sources) === q(['src']), 'the mark holds for this session');
  unlock();
  check(q(roots.rootsOf('C:\\work\\old').excluded) === q(['build']), "once it reads again the file's projects are back");
  const saved = read(file);
  check(q(saved['c:\\work\\old']) === q(old['c:\\work\\old']) && q(saved['c:\\work\\new']?.sources) === q(['src']),
    `and the mark made meanwhile is written onto them (${q(saved)})`);
}
{
  const data = path.join(work, 'roots-broken');
  fs.mkdirSync(data);
  process.env.PYIDE_USER_DATA = data;
  const file = path.join(data, 'project-roots.json');
  fs.writeFileSync(file, '{"c:\\\\work\\\\old": {"sources": ["li');
  const roots = fresh('project-roots.js');
  roots.mark('C:\\work\\new', 'C:\\work\\new\\src', 'sources');
  check(text(`${file}.bak`).startsWith('{"c:') && q(Object.keys(read(file))) === q(['c:\\work\\new']),
    'a broken project-roots.json is kept as .bak before the next mark writes a new one');
}

fs.rmSync(work, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
