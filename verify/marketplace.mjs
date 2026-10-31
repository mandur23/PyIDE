// The online plugin Marketplace (ports 9080-9081). Pure Node first (`--pure` stops there): scripts/marketplace.mjs, the
// committed marketplace/ folder, the index validator, the zip extractor's guards and the plugin manager's install from
// an index. Then the Settings › Plugins page against a local HTTP server and a folder index: listing, search, the
// trust dialog, a tampered download, install, update of an older installed version, a bad index, offline and Retry,
// plugins that need a newer PyIDE, and after a restart the installed plugins running and the page in Korean.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createServer } from 'http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';
import { buildMarketplace, zipFiles } from '../scripts/marketplace.mjs';

process.env.PYIDE_MARKETPLACE_URL ??= 'off';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const market = require('../main/marketplace.js');
const iconv = require('iconv-lite');
const { extractZip } = require('../main/zip.js');
const { createPluginManager } = require('../main/plugin-manager.js');
const APP_VERSION = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const rejects = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

// A plugin folder whose index.js records that it ran.
function writePlugin(root, meta, extra = {}) {
  const dir = path.join(root, meta.id);
  mkdirSync(path.join(dir, 'locales'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(meta, null, 2));
  writeFileSync(path.join(dir, 'index.js'), `(() => { window.__marketplaceRan = { ...(window.__marketplaceRan || {}), ${JSON.stringify(meta.id)}: ${JSON.stringify(meta.version)} }; })();\n`);
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(dir, name), text);
  return dir;
}

// The test Marketplace: word-count newer than the bundled sample, an online-only plugin, one that needs a newer PyIDE,
// and one whose zip is changed after the index was written.
function makeFeed() {
  const src = tempDir('market-src');
  const vendor = 'Example Vendor';
  writePlugin(src, { id: 'word-count', name: 'Statistic: Lines and Words', version: '0.9.2', vendor: 'PyIDE Samples',
    description: 'Line, word and character count.', detached: true,
    i18n: { ko: { name: '통계: 줄 수와 단어 수', description: '줄 수, 단어 수, 문자 수를 보여 줍니다.' } } });
  writeFileSync(path.join(src, 'word-count', 'index.js'), readFileSync(path.join(APP_DIR, 'plugins-catalog', 'word-count', 'index.js')));
  mkdirSync(path.join(src, 'word-count', 'locales'), { recursive: true });
  writeFileSync(path.join(src, 'word-count', 'locales', 'ko.json'), readFileSync(path.join(APP_DIR, 'plugins-catalog', 'word-count', 'locales', 'ko.json')));
  writePlugin(src, { id: 'hello-online', name: 'Hello Online', version: '1.0.0', vendor, description: 'Says hello from the online Marketplace.',
    homepage: 'https://example.com/hello-online', i18n: { ko: { name: '온라인 인사', description: '온라인 마켓플레이스에서 인사합니다.' } } });
  writePlugin(src, { id: 'future-plugin', name: 'Future Plugin', version: '1.0.0', vendor, description: 'Needs a newer PyIDE.', minIdeVersion: '99.0.0' });
  writePlugin(src, { id: 'tampered', name: 'Tampered Plugin', version: '1.0.0', vendor: 'Mallory Ltd', description: 'Its zip changed after the index was written.',
    i18n: { ko: { name: '변조된 플러그인', description: '인덱스를 쓴 뒤 zip이 바뀌었습니다.' } } });
  const feed = tempDir('market-feed');
  buildMarketplace({ source: src, out: feed });
  const zip = path.join(feed, 'tampered-1.0.0.zip');
  const bytes = readFileSync(zip);
  bytes[40] ^= 0xff;
  writeFileSync(zip, bytes);
  return feed;
}

// Serves a folder on 127.0.0.1, plus bad.json; `requests` lists the paths asked for.
function serve(dir, port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    requests.push(name);
    if (name === 'bad.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ format: 1, plugins: [{ id: 'bad', name: 'Bad', version: '1.0.0', vendor: 'X', description: 'x', url: 'bad.zip', sha256: 'nope', size: 10 }] }));
    }
    const file = path.join(dir, path.basename(name));
    if (!name || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200);
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, requests, port: server.address().port })));
}

// A port on 127.0.0.1 that nothing listens on.
const closedPort = async () => { const { server, port } = await serve(tempDir('market-none')); await new Promise((r) => server.close(r)); return port; };

// ---------- pure Node ----------
async function pure() {
  // scripts/marketplace.mjs
  const out = tempDir('market-out');
  writeFileSync(path.join(out, 'old-plugin-0.1.0.zip'), 'stale');
  const built = buildMarketplace({ out });
  const ids = built.index.plugins.map((p) => p.id).join();
  check(ids === 'key-promoter,rainbow-brackets,word-count', `the script lists the three sample plugins (${ids})`);
  check(built.index.plugins.every((p) => { const z = readFileSync(path.join(out, p.url)); return z.length === p.size && sha(z) === p.sha256; }),
    'each zip matches its size and sha256 in index.json');
  check(built.removed.join() === 'old-plugin-0.1.0.zip' && !existsSync(path.join(out, 'old-plugin-0.1.0.zip')), 'a zip the index no longer lists is removed');
  const again = buildMarketplace({ out });
  check(JSON.stringify(again.index) === JSON.stringify(built.index), 'building twice gives the same zips and sha256 (deterministic)');
  const committed = path.join(APP_DIR, 'marketplace', 'index.json');
  check(existsSync(committed) && readFileSync(committed, 'utf8') === readFileSync(path.join(out, 'index.json'), 'utf8')
    && built.index.plugins.every((p) => readFileSync(path.join(APP_DIR, 'marketplace', p.url)).equals(readFileSync(path.join(out, p.url)))),
  'the committed marketplace/ folder is up to date with plugins-catalog/ (run node scripts/marketplace.mjs)');
  check(built.index.plugins.every((p) => p.i18n?.ko?.name && /^[0-9a-f]{64}$/.test(p.sha256) && p.url === `${p.id}-${p.version}.zip`), 'entries carry Korean names and relative zip URLs');
  const unzipped = tempDir('market-unzip');
  extractZip(path.join(out, 'key-promoter-2.0.0.zip'), unzipped);
  check(readFileSync(path.join(unzipped, 'style.css')).equals(readFileSync(path.join(APP_DIR, 'plugins-catalog', 'key-promoter', 'style.css')))
    && existsSync(path.join(unzipped, 'locales', 'ko.json')), 'a built zip unpacks to the plugin folder byte for byte');

  // The index validator
  const base = 'https://example.com/market/index.json';
  const entry = { id: 'demo', name: 'Demo', version: '1.0.0', vendor: 'V', description: 'D', url: 'demo-1.0.0.zip', sha256: 'a'.repeat(64), size: 10 };
  const index = (plugins, extra = {}) => JSON.stringify({ format: 1, plugins, ...extra });
  const ok = market.parseIndex(index([entry, { ...entry, id: 'demo.two', url: 'http://127.0.0.1:8000/d.zip', homepage: 'https://example.com', minIdeVersion: '0.2.5' }]), base);
  check(ok[0].url === 'https://example.com/market/demo-1.0.0.zip' && ok[1].url === 'http://127.0.0.1:8000/d.zip' && ok[1].minIdeVersion === '0.2.5',
    'a valid index parses; relative URLs resolve against it, http on 127.0.0.1 is allowed');
  check(!('extra' in market.parseIndex(index([{ ...entry, extra: 1 }]), base)[0]), 'unknown fields are dropped');
  const bad = {
    'not JSON': ['{', /is not JSON/],
    'format 2': [index([], { format: 2 }), /format 2, which needs a newer Nano Studio/],
    'no plugins list': [JSON.stringify({ format: 1 }), /"plugins" must be a list/],
    'uppercase id': [index([{ ...entry, id: 'Demo' }]), /plugins\[0\]\.id must be/],
    'path in id': [index([{ ...entry, id: '../x' }]), /plugins\[0\]\.id must be/],
    'device name id': [index([{ ...entry, id: 'con' }]), /plugins\[0\]\.id must be/],
    'duplicate id': [index([entry, entry]), /plugins\[1\]\.id "demo" is listed twice/],
    'bad version': [index([{ ...entry, version: '1.0' }]), /plugins\[0\]\.version must be a version/],
    'plain http url': [index([{ ...entry, url: 'http://example.com/demo.zip' }]), /plugins\[0\]\.url must be https/],
    'file url in an online index': [index([{ ...entry, url: 'file:///C:/demo.zip' }]), /plugins\[0\]\.url must be https/],
    'bad sha256': [index([{ ...entry, sha256: 'xyz' }]), /plugins\[0\]\.sha256 must be 64 hexadecimal digits/],
    'zero size': [index([{ ...entry, size: 0 }]), /plugins\[0\]\.size must be/],
    'oversized plugin': [index([{ ...entry, size: 21 * 1024 * 1024 }]), /plugins\[0\]\.size must be/],
    'http homepage': [index([{ ...entry, homepage: 'http://example.com' }]), /plugins\[0\]\.homepage must be https/],
    'control character': [index([{ ...entry, name: 'De\u0007mo' }]), /plugins\[0\]\.name contains control characters/],
    'huge index': [index([{ ...entry, description: 'x'.repeat(1100000) }]), /larger than 1024 KB/],
  };
  const failures = Object.entries(bad).filter(([, [raw, re]]) => !re.test(throws(() => market.parseIndex(raw, base))));
  check(!failures.length, `invalid indexes are refused with a message naming the field${failures.length ? `: ${failures.map(([k, [raw]]) => `${k} -> ${throws(() => market.parseIndex(raw, base)) || 'accepted'}`).join('; ')}` : ''}`);
  check(market.parseIndex(index([{ ...entry, url: 'demo.zip' }]), pathToFileURL(path.join(out, 'index.json')).href)[0].url.startsWith('file:'), 'a local index may point at local zips');
  const order = ['0.2.4', '0.2.5-beta.1', '0.2.5-beta.2', '0.2.5', '0.2.10', '1.0.0'];
  check(order.every((v, i) => i === 0 || (market.compareVersions(order[i - 1], v) < 0 && market.compareVersions(v, order[i - 1]) > 0)) && market.compareVersions('1.0.0', '1.0.0') === 0,
    `versions compare as semver, prereleases first (${order.join(' < ')})`);
  check(market.resolveSource(out).href === pathToFileURL(path.join(out, 'index.json')).href && market.resolveSource('https://h.example/m/').href === 'https://h.example/m/index.json'
    && /must use https/.test(throws(() => market.resolveSource('http://example.com/index.json'))) && market.resolveSource('') === null,
  'the index location: a folder means its index.json, https only (http on this computer), empty means none');
  const env = process.env.PYIDE_MARKETPLACE_URL;
  process.env.PYIDE_MARKETPLACE_URL = 'off';
  const offDefault = market.defaultSource({ packaged: true });
  delete process.env.PYIDE_MARKETPLACE_URL;
  const defaults = [market.defaultSource({ packaged: true }), market.defaultSource({ packaged: false })];
  process.env.PYIDE_MARKETPLACE_URL = env;
  check(offDefault === '' && defaults[0] === 'https://raw.githubusercontent.com/mandur23/PyIDE/master/marketplace/index.json' && defaults[1] === '',
    'installed copies default to the GitHub index, source runs to none, PYIDE_MARKETPLACE_URL=off to none');

  // The zip extractor's guards
  const zipDir = tempDir('market-zips');
  const dest = (name) => path.join(zipDir, `out-${name}`);
  const plain = (name, text = 'x') => ({ name, data: Buffer.from(text) });
  const tryZip = (name, buf, limits) => { const f = path.join(zipDir, `${name}.zip`); writeFileSync(f, buf); return throws(() => extractZip(f, dest(name), limits)); };
  const slips = ['../evil.txt', 'a/../../evil.txt', '/abs.txt', 'C:/evil.txt', 'a\\..\\..\\evil.txt', 'file.txt:stream', 'con.txt', 'trailing. '];
  const slipped = slips.filter((n) => !/unsafe name/.test(tryZip(`slip${slips.indexOf(n)}`, zipFiles([plain('plugin.json', '{}'), plain(n)]))));
  check(!slipped.length && !existsSync(path.join(zipDir, 'evil.txt')) && !existsSync(path.join(path.dirname(zipDir), 'evil.txt')),
    `entries that would land outside the folder are refused before anything is written${slipped.length ? ` (accepted: ${slipped.join(', ')})` : ''}`);
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  check(/unpacks to more than 1 MB/.test(tryZip('big', zipFiles([{ name: 'zeros.bin', data: zeros }]), { archive: 1e6, total: 1024 * 1024, entries: 10 })),
    'an archive whose declared size passes the limit is refused');
  const lying = zipFiles([{ name: 'zeros.bin', data: zeros }]);
  const cd = lying.readUInt32LE(lying.length - 6);
  lying.writeUInt32LE(100, cd + 24);
  check(/does not unpack to its declared size/.test(tryZip('lying', lying)) && !existsSync(path.join(dest('lying'), 'zeros.bin')),
    'an entry that inflates beyond its declared size (a zip bomb) is stopped at that size and not written');
  const crc = zipFiles([plain('plugin.json', '{"id":"x"}')]);
  crc.writeUInt32LE(0, crc.readUInt32LE(crc.length - 6) + 16);
  check(/CRC mismatch/.test(tryZip('crc', crc)), 'an entry with a wrong CRC is refused');
  const link = zipFiles([plain('link')]);
  link.writeUInt32LE((0o120777 << 16) >>> 0, link.readUInt32LE(link.length - 6) + 38);
  check(/symbolic link/.test(tryZip('link', link)), 'a symbolic link entry is refused');
  check(/twice/.test(tryZip('dupe', zipFiles([plain('A.txt'), plain('a.txt')]))), 'two entries that are the same file on Windows are refused');
  check(/not a zip archive/.test(tryZip('notzip', Buffer.from('hello'))), 'a file that is not a zip is refused');
  // Windows Explorer's "Send to › Compressed folder" writes names in the OEM code page without the UTF-8 flag.
  const legacy = Buffer.from(zipFiles([plain('plugin.json', '{}'), plain('locales/XXXXXX.md', '# help'), plain('caf_.txt'), plain('YYYY/ZZZZ.txt')]));
  const swaps = [['XXXXXX', iconv.encode('도움말', 'cp949')], ['caf_', Buffer.from([0x63, 0x61, 0x66, 0x82])], ['YYYY', iconv.encode('과제', 'cp949')], ['ZZZZ', iconv.encode('숙제', 'cp949')]];
  for (const [from, to] of swaps) for (let i = legacy.indexOf(from); i >= 0; i = legacy.indexOf(from, i + to.length)) to.copy(legacy, i);
  for (let i = 0; i + 4 <= legacy.length; i++) {
    const at = { [0x04034b50]: 6, [0x02014b50]: 8 }[legacy.readUInt32LE(i)];
    if (at) legacy.writeUInt16LE(legacy.readUInt16LE(i + at) & ~0x800, i + at);
  }
  const legacyError = tryZip('legacy', legacy);
  const unpacked = existsSync(dest('legacy')) ? readdirSync(dest('legacy'), { recursive: true }).map(String).sort().join() : '';
  check(!legacyError && unpacked === ['café.txt', 'locales', 'locales\\도움말.md', 'plugin.json', '과제', '과제\\숙제.txt'].sort().join()
    && readFileSync(path.join(dest('legacy'), 'locales', '도움말.md'), 'utf8') === '# help',
  `names without the UTF-8 flag unpack as CP949 when they are CP949, else CP437 (${legacyError || unpacked})`);

  // The plugin manager installing from an index, over HTTP
  const feed = makeFeed();
  const { server, requests, port } = await serve(feed);
  try {
    const userData = tempDir('market-pm');
    const pm = createPluginManager({ appDir: APP_DIR, userDataDir: userData });
    const listing = await pm.marketplace(`http://127.0.0.1:${port}/index.json`);
    const byId = Object.fromEntries(listing.plugins.map((p) => [p.id, p]));
    check(listing.online.state === 'ok' && listing.online.hidden === 1 && !byId['future-plugin'], `the plugin that needs Nano Studio 99 is hidden (${JSON.stringify(listing.online)})`);
    check(byId['word-count']?.origin === 'online' && byId['word-count'].version === '0.9.2' && byId['key-promoter']?.origin === 'bundled',
      'an online version newer than the bundled sample replaces it; other samples stay bundled');
    check(/does not match the index's sha256/.test(await rejects(pm.installListed('tampered'))) && !existsSync(path.join(userData, 'plugins', 'tampered')),
      'a download whose sha256 differs from the index is not installed');
    check((await pm.installListed('hello-online'))?.id === 'hello-online' && readJson(path.join(userData, 'plugins', 'hello-online', 'plugin.json')).version === '1.0.0'
      && requests.includes('hello-online-1.0.0.zip'), 'an online plugin downloads over HTTP and installs');
    check(!readdirSync(userData).some((f) => /^plugin-(zip|download|new|old)-/.test(f)), 'no download, extraction, staging or old folder is left in user data');
    const older = path.join(userData, 'plugins', 'word-count');
    mkdirSync(older, { recursive: true });
    writeFileSync(path.join(older, 'plugin.json'), JSON.stringify({ id: 'word-count', name: 'Word Count', version: '0.9.0' }));
    const relisted = Object.fromEntries((await pm.marketplace(`http://127.0.0.1:${port}/index.json`)).plugins.map((p) => [p.id, p]));
    check(relisted['word-count'].update && relisted['word-count'].installedVersion === '0.9.0' && !relisted['hello-online'].update && relisted['hello-online'].installedVersion === '1.0.0',
      'an installed version older than the index is offered as an update, the same version is not');
    const wrong = path.join(tempDir('market-wrong'), 'index.json');
    const w = readJson(path.join(feed, 'index.json'));
    w.plugins.find((p) => p.id === 'hello-online').version = '1.0.1';
    writeFileSync(wrong, JSON.stringify(w));
    writeFileSync(path.join(path.dirname(wrong), 'hello-online-1.0.0.zip'), readFileSync(path.join(feed, 'hello-online-1.0.0.zip')));
    await pm.marketplace(wrong);
    check(/holds hello-online 1.0.0, not hello-online 1.0.1/.test(await rejects(pm.installListed('hello-online'))), 'a zip whose plugin.json is another version than the index says is refused');
    const dead = await closedPort();
    const offline = await pm.marketplace(`http://127.0.0.1:${dead}/index.json`, { refresh: true });
    check(offline.online.state === 'error' && offline.online.error === `Cannot reach 127.0.0.1:${dead} (ECONNREFUSED)` && offline.plugins.length === 3,
      `an unreachable index is an error, and the bundled samples are still listed (${offline.online.error})`);
  } finally {
    server.close();
  }
  await reinstallHeld();
}

// Reinstalling over a plugin whose folder another program holds (a helper process running in it, an antivirus scan).
async function reinstallHeld() {
  const userData = tempDir('market-held');
  const pm = createPluginManager({ appDir: APP_DIR, userDataDir: userData });
  const src = tempDir('market-held-src');
  const v1 = writePlugin(path.join(src, 'v1'), { id: 'held', name: 'Held', version: '1.0.0' }, { 'helper.txt': 'v1 helper' });
  mkdirSync(path.join(v1, 'bin'), { recursive: true });
  writeFileSync(path.join(v1, 'bin', 'tool.txt'), 'v1 tool');
  const v2 = writePlugin(path.join(src, 'v2'), { id: 'held', name: 'Held', version: '2.0.0' });
  const installed = path.join(userData, 'plugins', 'held');
  const snapshot = (dir) => readdirSync(dir, { recursive: true }).map(String).sort().join();
  pm.install(v1);
  const before = snapshot(installed);
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(installed, 'bin'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  let error = '';
  try {
    error = throws(() => pm.install(v2));
    check(snapshot(installed) === before && readJson(path.join(installed, 'plugin.json')).version === '1.0.0'
      && readFileSync(path.join(installed, 'bin', 'tool.txt'), 'utf8') === 'v1 tool',
    `a reinstall that cannot replace the folder leaves version 1 complete (${snapshot(installed)})`);
    check(/in use/.test(error) && error.includes('held'), `the error says the plugin folder is in use (${error || 'no error'})`);
    check(pm.list().filter((p) => p.id === 'held').map((p) => p.version).join() === '1.0.0', 'the plugin list still shows version 1 once');
    check(/in use/.test(throws(() => pm.uninstall('held'))) && readJson(path.join(installed, 'plugin.json')).version === '1.0.0', 'an uninstall that cannot remove the folder leaves the plugin intact');
  } finally {
    helper.kill();
  }
  await new Promise((r) => helper.once('exit', r));
  check(pm.install(v2)?.id === 'held' && readJson(path.join(installed, 'plugin.json')).version === '2.0.0' && !existsSync(path.join(installed, 'bin')),
    'once the folder is free the reinstall replaces version 1 with version 2 (no file of version 1 left)');
  check(readdirSync(userData).join() === 'plugins' && readdirSync(path.join(userData, 'plugins')).join() === 'held',
    `no staging or old folder is left behind (${readdirSync(userData).join()} / ${readdirSync(path.join(userData, 'plugins')).join()})`);
}

// ---------- the Plugins page ----------
async function ui() {
  const feed = makeFeed();
  const http = await serve(feed);
  const indexUrl = `http://127.0.0.1:${http.port}/index.json`;
  const userData = tempDir('market-userdata');
  const olderHello = path.join(userData, 'plugins', 'hello-online');
  mkdirSync(olderHello, { recursive: true });
  writeFileSync(path.join(olderHello, 'plugin.json'), JSON.stringify({ id: 'hello-online', name: 'Hello Online', version: '0.9.0', vendor: 'Example Vendor', description: 'Old.' }));
  writeFileSync(path.join(olderHello, 'index.js'), "window.__marketplaceRan = { 'hello-online': '0.9.0' };\n");

  const a = await launch({ fixture: 'core', port: 9080, name: 'marketplace', userData, env: { PYIDE_MARKETPLACE_URL: indexUrl } });
  const rows = () => a.js(`[...document.querySelectorAll('#pluginsList .plugin-row')].map(r => r.dataset.id + ':' + (r.querySelector('.plugin-install')?.textContent || '')).join()`);
  const status = () => a.js(`document.querySelector('#pluginsStatus').textContent`);
  const trustDialog = `document.querySelector('#pluginTrustDialog')`;
  try {
    await a.js(`ide.openSettings('plugins')`);
    await a.until(`!!document.querySelector('#pluginsList .plugin-row[data-id="hello-online"] .plugin-update')`, 'update offered on the Installed tab');
    check(await a.js(`document.querySelector('#pluginsList .plugin-row[data-id="hello-online"] .plugin-update').textContent === 'Update'`), 'the Installed tab offers Update for a plugin with a newer Marketplace version');
    await a.click('#pluginsList .plugin-row[data-id="hello-online"]');
    await a.until(`!!document.querySelector('#pluginUpdateBtn')`, 'update button in details');
    check(await a.js(`[...document.querySelectorAll('#pluginsDetail .plugin-badge')].some(b => b.textContent === 'Version 1.0.0 available') && document.querySelector('#pluginHomepageBtn') !== null`),
      'its details say which version is available and link the homepage');

    await a.click('.plugins-tab[data-tab="marketplace"]');
    await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 5`, 'marketplace listing');
    const listed = await rows();
    check(listed === 'key-promoter:Install,rainbow-brackets:Install,word-count:Install,hello-online:Update,tampered:Install',
      `bundled samples and online plugins are listed together, with Install and Update (${listed})`);
    check(await a.js(`document.querySelector('#pluginsList .plugin-row[data-id="word-count"] .plugin-sub').textContent.includes('0.9.2')`), 'the online word-count 0.9.2 replaces the bundled 0.9.1');
    await a.shot('marketplace-list.png');
    check(await a.js(`document.querySelector('#pluginsOnline')?.textContent === 'Not shown because they need a newer Nano Studio: 1' && !document.querySelector('#pluginsList .plugin-row[data-id="future-plugin"]')`),
      'a plugin that needs a newer Nano Studio is not listed, and the list says so');
    await a.click('.plugins-filter');
    await a.type('hello');
    check((await rows()) === 'hello-online:Update', 'the search box filters the Marketplace');
    await a.js(`(() => { const f = document.querySelector('.plugins-filter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);

    await a.click('#pluginsList .plugin-row[data-id="tampered"] .plugin-install');
    await a.until(`!!${trustDialog}`, 'trust dialog');
    const trust = await a.js(`${trustDialog}.textContent`);
    await a.shot('marketplace-trust.png');
    check(trust.includes('Install Third-Party Plugin') && trust.includes('Mallory Ltd') && trust.includes(`http://127.0.0.1:${http.port}/tampered-1.0.0.zip`) && trust.includes('same access as Nano Studio'),
      'installing an online plugin first names its vendor and download source and warns that plugins are code');
    await a.click('#pluginTrustDialog .dialog-buttons .primary');
    await a.until(`document.querySelector('#pluginsStatus').textContent.startsWith('Could not install')`, 'tampered refused');
    check(/does not match the index's sha256/.test(await status()) && !existsSync(path.join(userData, 'plugins', 'tampered')), `a tampered download is refused (${await status()})`);

    await a.click('#pluginsList .plugin-row[data-id="word-count"] .plugin-install');
    await a.until(`!!${trustDialog}`, 'trust dialog for word-count');
    await a.js(`[...document.querySelectorAll('#pluginTrustDialog .dialog-buttons button')].find(b => b.textContent === 'Cancel').click()`);
    await a.until(`!${trustDialog}`, 'trust dialog closed');
    check(!existsSync(path.join(userData, 'plugins', 'word-count')) && !http.requests.includes('word-count-0.9.2.zip'), 'Cancel in the trust dialog downloads nothing');

    await a.click('#pluginsList .plugin-row[data-id="word-count"] .plugin-install');
    await a.until(`!!${trustDialog}`, 'trust dialog for word-count again');
    await a.click('#pluginTrustDialog .dialog-buttons .primary');
    await a.until(`document.querySelector('#pluginsList .plugin-row[data-id="word-count"] .plugin-install')?.textContent === 'Installed'`, 'word-count installed');
    check(readJson(path.join(userData, 'plugins', 'word-count', 'plugin.json')).version === '0.9.2' && (await status()).startsWith('Installed')
      && await a.js(`document.querySelector('#pluginsList .plugin-row[data-id="word-count"] .plugin-install').disabled`),
    'the online plugin is downloaded, checked and installed, and shows as Installed');

    await a.click('.plugins-tab[data-tab="installed"]');
    await a.click('#pluginsList .plugin-row[data-id="hello-online"] .plugin-update');
    await a.until(`${trustDialog}?.querySelector('.dialog-title').textContent === 'Update Third-Party Plugin'`, 'update trust dialog');
    await a.click('#pluginTrustDialog .dialog-buttons .primary');
    await a.until(`!document.querySelector('#pluginsList .plugin-row[data-id="hello-online"] .plugin-update')`, 'updated');
    check(readJson(path.join(userData, 'plugins', 'hello-online', 'plugin.json')).version === '1.0.0', 'Update replaces the older installed version');
    await a.click('#pluginsList .plugin-row[data-id="hello-online"]');
    check(await a.js(`[...document.querySelectorAll('#pluginsDetail .plugin-badge')].some(b => b.textContent === 'Restart required') && !document.querySelector('#pluginUpdateBtn')`),
      'the updated plugin waits for a restart and no longer offers an update');

    // Gear › Manage Plugin Repositories…, type the index location, OK. Returns what the field showed first.
    const setRepo = async (value) => {
      await a.click('#pluginsGear');
      await a.until(`[...document.querySelectorAll('#pluginsGearMenu .menu-item')].some(n => n.textContent === 'Manage Plugin Repositories…')`, 'gear menu');
      await a.js(`[...document.querySelectorAll('#pluginsGearMenu .menu-item')].find(n => n.textContent === 'Manage Plugin Repositories…').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await a.until(`!!document.querySelector('#pluginsRepoUrl')`, 'repository dialog');
      const shown = await a.js(`document.querySelector('#pluginsRepoUrl').value`);
      await a.js(`(() => { const i = document.querySelector('#pluginsRepoUrl'); i.focus(); i.select(); })()`);
      if (value) await a.type(value); else await a.press('Delete');
      await a.click('#pluginRepoDialog .dialog-buttons .primary');
      await a.until(`!document.querySelector('#pluginRepoDialog') && document.querySelector('.plugins-tab.active').dataset.tab === 'marketplace'`, 'repository saved');
      return shown;
    };
    check((await setRepo(`http://127.0.0.1:${http.port}/bad.json`)) === indexUrl, 'Manage Plugin Repositories starts with the index in use');
    await a.until(`document.querySelector('#pluginsOnline.error')`, 'bad index error');
    const badText = await a.js(`document.querySelector('#pluginsOnline').textContent`);
    check(badText.includes('Could not load the online Marketplace') && badText.includes('Marketplace index is not valid: plugins[0].sha256 must be 64 hexadecimal digits'),
      `a bad index is refused with a readable message (${badText})`);
    check((await rows()) === 'key-promoter:Install,rainbow-brackets:Install,word-count:Installed', `the bundled samples are still listed (${await rows()})`);

    check(await a.js(`ide.settings.get('plugins.marketplaceUrl') === ${JSON.stringify(`http://127.0.0.1:${http.port}/bad.json`)}`), 'the repository is saved in plugins.marketplaceUrl');
    await setRepo(indexUrl);
    await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 5 && !document.querySelector('#pluginsOnline.error')`, 'good index again');
    check(await a.js(`!('plugins.marketplaceUrl' in ide.settings.all()) || ide.settings.get('plugins.marketplaceUrl') === undefined`), 'setting the default index back stores no URL, so it follows the default');
    http.server.close();
    http.server.closeAllConnections?.();
    await setRepo(indexUrl);
    await a.until(`document.querySelector('#pluginsOnline.error #pluginsRetry')`, 'offline error with Retry', 30000);
    const offText = await a.js(`document.querySelector('#pluginsOnline').textContent`);
    check(/Cannot reach 127\.0\.0\.1:\d+/.test(offText) && (await rows()).startsWith('key-promoter:Install,rainbow-brackets:Install'), `offline: the error says the server cannot be reached and offers Retry (${offText})`);
    const back = await serve(feed, http.port);
    await a.click('#pluginsRetry');
    await a.until(`!document.querySelector('#pluginsOnline.error') && document.querySelectorAll('#pluginsList .plugin-row').length === 5`, 'retry succeeded', 20000);
    check(back.requests.includes('index.json'), 'Retry reads the index again and lists the online plugins');
    back.server.close();

    await setRepo(feed);
    await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 5 && !document.querySelector('#pluginsOnline.error')`, 'folder index');
    check((await rows()) === 'key-promoter:Install,rainbow-brackets:Install,word-count:Installed,hello-online:Installed,tampered:Install', `a local folder works as the index (${await rows()})`);
    await setRepo('');
    await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 3 && !document.querySelector('#pluginsOnline')`, 'online off');
    check(await a.js(`ide.settings.get('plugins.marketplaceUrl') === ''`), 'an empty repository turns the online Marketplace off (bundled samples only)');
    await a.shot('marketplace.png');
    check(a.consoleErrors.length === 0, 'no renderer exceptions');
  } catch (err) {
    check(false, err.message.split('\n')[0]);
    await a.shot('failure.png').catch(() => {});
  }
  a.close();
  http.server.close();

  // After a restart, in Korean: the installed and updated plugins run; the page, the trust dialog and the repository
  // dialog are translated.
  const ko = await serve(feed);
  const b = await launch({ fixture: 'core', port: 9081, name: 'marketplace-ko', userData, lang: 'ko-KR', env: { PYIDE_MARKETPLACE_URL: `http://127.0.0.1:${ko.port}/index.json` } });
  try {
    await b.until(`window.__marketplaceRan?.['hello-online'] === '1.0.0' && !!document.querySelector('#wordCountStatus')`, 'installed plugins running');
    check(true, 'after a restart the updated hello-online 1.0.0 and the downloaded word-count run');
    await b.js(`ide.settings.set('plugins.marketplaceUrl', undefined)`);
    await b.js(`ide.openSettings('plugins')`);
    await b.click('.plugins-tab[data-tab="marketplace"]');
    await b.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 5`, 'Korean marketplace listing');
    check(await b.js(`document.querySelector('#pluginsList .plugin-row[data-id="hello-online"] .plugin-name').textContent === '온라인 인사' && document.querySelector('#pluginsList .plugin-row[data-id="hello-online"] .plugin-install').textContent === '설치됨'`),
      'the online plugin shows its Korean name and 설치됨');
    const extra = ['Key', 'Promoter', 'Bundled'];
    const leaks = await englishLeaks(b, '.settings-dialog', extra);
    check(!leaks.length, `the Marketplace tab has no untranslated text${leaks.length ? `: ${JSON.stringify(leaks.slice(0, 5))}` : ''}`);
    await b.click('#pluginsList .plugin-row[data-id="tampered"] .plugin-install');
    await b.until(`!!document.querySelector('#pluginTrustDialog')`, 'Korean trust dialog');
    const trustLeaks = await englishLeaks(b, '#pluginTrustDialog');
    check(!trustLeaks.length && (await b.js(`document.querySelector('#pluginTrustDialog .dialog-title').textContent`)) === '서드파티 플러그인 설치',
      `the trust dialog is in Korean${trustLeaks.length ? `: ${JSON.stringify(trustLeaks)}` : ''}`);
    await b.js(`[...document.querySelectorAll('#pluginTrustDialog .dialog-buttons button')].find(x => x.textContent === '취소').click()`);
    await b.js(`ide.settings.set('plugins.marketplaceUrl', 'http://127.0.0.1:${await closedPort()}/index.json')`);
    await b.click('.plugins-tab[data-tab="installed"]');
    await b.click('.plugins-tab[data-tab="marketplace"]');
    await b.click('#pluginsGear');
    await b.until(`!!document.querySelector('#pluginsGearMenu')`, 'Korean gear menu');
    const gearLeaks = await englishLeaks(b, '#pluginsGearMenu');
    await b.js(`document.querySelectorAll('#pluginsGearMenu .menu-item')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await b.until(`!!document.querySelector('#pluginRepoDialog')`, 'Korean repository dialog');
    const repoLeaks = await englishLeaks(b, '#pluginRepoDialog');
    check(!gearLeaks.length && !repoLeaks.length, `the gear menu and the repository dialog are in Korean${[...gearLeaks, ...repoLeaks].length ? `: ${JSON.stringify([...gearLeaks, ...repoLeaks])}` : ''}`);
    await b.click('#pluginRepoDialog .dialog-buttons .primary');
    await b.until(`!!document.querySelector('#pluginsOnline.error #pluginsRetry')`, 'Korean offline error');
    const offLeaks = await englishLeaks(b, '.settings-dialog', extra);
    check(!offLeaks.length && (await b.js(`document.querySelector('#pluginsRetry').textContent`)) === '다시 시도', `the offline message and Retry are in Korean${offLeaks.length ? `: ${JSON.stringify(offLeaks)}` : ''}`);
    const koDict = readJson(path.join(APP_DIR, 'renderer', 'features', 'settings', 'locales', 'ko.json'));
    const source = readFileSync(path.join(APP_DIR, 'renderer', 'features', 'settings', 'index.js'), 'utf8');
    const page = source.slice(source.indexOf('// ---------- Plugins page'), source.indexOf('// ---------- Python Interpreter page'));
    const mine = [...new Set([...page.matchAll(/\btr\('([^']*)'/g)].map((m) => m[1]))].filter((s) => !(s in koDict))
      .concat((await missingTranslations(b)).filter((s) => page.includes(`'${s}'`)));
    check(!mine.length, `every Plugins page string has a Korean entry${mine.length ? `: ${JSON.stringify(mine)}` : ''}`);
    await b.shot('marketplace-ko.png');
    check(b.consoleErrors.length === 0, 'no renderer exceptions in Korean');
  } catch (err) {
    check(false, err.message.split('\n')[0]);
    await b.shot('failure-ko.png').catch(() => {});
  }
  b.close();
  ko.server.close();
}

try {
  await pure();
  if (!process.argv.includes('--pure')) await ui();
} catch (err) {
  check(false, err.stack || err.message);
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
