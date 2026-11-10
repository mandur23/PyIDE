// IPC answers only the app's own pages (main/ipc-guard.js): the IDE page's top frame on any channel, the chooser on
// its own channels, nothing else (a subframe, a foreign page, a frame that is gone). Plain Node with a stand-in
// ipcMain, plus the checks that keep it the only way in: main.js installs it before anything registers, its chooser
// list is preload.js's, its page URLs are main/windows.js's. The real app: verify/security.mjs.
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { guardIpc, appPages, CHOOSER_CHANNELS } = require(path.join(ROOT, 'main', 'ipc-guard.js'));
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const appDir = 'C:\\Program Files\\Nano Studio\\resources\\app.asar';
const fake = new EventEmitter();
const handlers = new Map();
fake.handle = (ch, fn) => { handlers.set(ch, fn); };
fake.handleOnce = fake.handle;
fake.removeHandler = (ch) => handlers.delete(ch);
const refusedLog = [];
guardIpc(fake, { appDir, onRefused: (r) => refusedLog.push(r) });

const pages = appPages(appDir);
const top = (url) => ({ senderFrame: { parent: null, url } });
const ide = top(`${pages.ide}?mode=code&product=Nano%20Studio`);
const ideUpper = top(`${pages.ide.replace('Nano%20Studio', 'NANO%20STUDIO')}?detached=1`);
const chooser = top(`${pages.chooser}?product=Nano%20Studio`);
const sub = { senderFrame: { parent: ide.senderFrame, url: pages.ide } };
const foreign = top('https://example.com/');
const otherFile = top(pathToFileURL('C:\\Users\\x\\Downloads\\index.html').href);
const unc = top(pages.ide.replace('file:///', 'file://host/'));
const gone = { senderFrame: null };

fake.handle('fs:read', (_e, p) => `read ${p}`);
fake.handle('core:localeSync', () => 'dict');
const invoke = (ch, e, ...a) => Promise.resolve().then(() => handlers.get(ch)(e, ...a)).then((v) => v, (err) => `refused: ${err.message}`);
check(await invoke('fs:read', ide, 'a') === 'read a' && await invoke('fs:read', ideUpper, 'b') === 'read b', 'the IDE page (main, detached, any mode, any letter case) reaches every handler');
const denied = await Promise.all([sub, foreign, otherFile, unc, gone].map((e) => invoke('fs:read', e, 'x')));
check(denied.every((r) => r.startsWith('refused')), `a subframe, a web page, another local page, a page on a share and a gone frame are refused (${denied.join(' / ')})`);
check(await invoke('core:localeSync', chooser) === 'dict' && (await invoke('fs:read', chooser, 'x')).startsWith('refused'), 'the chooser reaches its own channels only');

let calls = 0;
const onSync = (e) => { calls++; e.returnValue = 'value'; };
fake.on('settings:loadSync', onSync);
const sync = (e) => { const ev = { ...e }; fake.emit('settings:loadSync', ev); return ev.returnValue; };
check(sync(ide) === 'value' && sync(sub) === null && calls === 1, 'a refused sendSync gets null and never reaches the listener');
fake.removeListener('settings:loadSync', onSync);
check(fake.listenerCount('settings:loadSync') === 0, 'removeListener with the original function removes the guarded one (main/windows.js does)');
let onceCalls = 0;
const onceFn = () => { onceCalls++; };
fake.once('chooser:pick', onceFn);
fake.off('chooser:pick', onceFn);
fake.emit('chooser:pick', { ...chooser });
check(onceCalls === 0 && fake.listenerCount('chooser:pick') === 0, 'so does off() for a once() listener');
fake.once('chooser:close', onceFn);
fake.emit('chooser:close', { ...chooser });
fake.emit('chooser:close', { ...chooser });
fake.once('chooser:update', onceFn);
fake.emit('chooser:update', { ...sub });
check(onceCalls === 1 && fake.listenerCount('chooser:close') === 0 && fake.listenerCount('chooser:update') === 1, 'a once() listener runs once for its page, and a refused message does not use it up');
check(refusedLog.some((r) => r.channel === 'fs:read' && r.why === 'a subframe') && refusedLog.some((r) => r.why === 'the chooser'), 'refusals are reported with the channel and why');

// The guard must wrap ipcMain before the first registration anywhere: main.js's own, main/diagnostics' and the features'.
const main = readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const guardAt = main.indexOf("require('./main/ipc-guard').guardIpc(ipcMain");
const firstUse = main.search(/ipcMain\.(handle|on|once|handleOnce|addListener)\(/);
const firstModule = main.search(/require\('\.\/main\/(?!test-env'|ipc-guard')/);
check(guardAt > 0 && guardAt < firstUse && guardAt < firstModule, 'main.js wraps ipcMain before it registers a handler or loads a module that could');

const preload = readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const chooserBlock = /chooserPage && pagePath\(location\.href\) === chooserPage\) contextBridge\.exposeInMainWorld\('api', \{([\s\S]*?)\n\}\);/.exec(preload)?.[1] || '';
const exposed = new Set([...chooserBlock.matchAll(/ipcRenderer\.(?:send|sendSync|invoke|on)\('([^']+)'/g)].map((m) => m[1]).filter((c) => c !== 'updater:state'));
check(exposed.size && [...exposed].every((c) => CHOOSER_CHANNELS.has(c)) && [...CHOOSER_CHANNELS].every((c) => exposed.has(c)), `the chooser's channels are the ones preload.js gives it (${[...exposed].join(', ')})`);

const windows = readFileSync(path.join(ROOT, 'main', 'windows.js'), 'utf8');
check(windows.includes("`--pyide-page=${pathToFileURL(path.join(appDir, 'renderer', 'index.html')).href}`")
  && windows.includes("const page = path.join(appDir, 'renderer', 'chooser.html');") && windows.includes('`--pyide-chooser=${pathToFileURL(page).href}`'),
  'its pages are the ones main/windows.js tells the preload');

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
