// Installing a Marketplace plugin from the installed app's app.asar (reported from 0.2.4: fs.cpSync cannot read
// inside an asar, "ENOENT … lstat …app.asar\plugins-catalog\word-count"). Packs a small app with a plugins-catalog into a
// real asar, then runs the plugin manager in Electron's Node mode (which reads asar archives like the app does).
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

const work = tempDir('plugin-asar');
const app = path.join(work, 'app');
const demo = path.join(app, 'plugins-catalog', 'demo-plugin');
mkdirSync(path.join(demo, 'locales'), { recursive: true });
mkdirSync(path.join(demo, 'assets', 'deeper'), { recursive: true });
writeFileSync(path.join(demo, 'plugin.json'), JSON.stringify({ id: 'demo-plugin', name: 'Demo Plugin', version: '1.0.0' }));
writeFileSync(path.join(demo, 'index.js'), '// demo\n');
writeFileSync(path.join(demo, 'locales', 'ko.json'), JSON.stringify({ 'Demo Plugin': '데모 플러그인' }));
const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
writeFileSync(path.join(demo, 'assets', 'deeper', 'icon.bin'), bytes);
mkdirSync(path.join(app, 'renderer', 'features'), { recursive: true });
mkdirSync(path.join(app, 'main', 'features'), { recursive: true });
const archive = path.join(work, 'app.asar');
await asar.createPackage(app, archive);

const userData = path.join(work, 'userdata');
const script = path.join(work, 'run.cjs');
writeFileSync(script, `
const fs = require('fs'), path = require('path');
const { createPluginManager } = require(${JSON.stringify(path.join(APP_DIR, 'main', 'plugin-manager.js'))});
const appDir = ${JSON.stringify(archive)};
const out = {};
try { fs.cpSync(path.join(appDir, 'plugins-catalog', 'demo-plugin'), path.join(${JSON.stringify(work)}, 'cp-probe'), { recursive: true }); out.cpSync = 'ok'; }
catch (e) { out.cpSync = e.code || e.message; }
const pm = createPluginManager({ appDir, userDataDir: ${JSON.stringify(userData)} });
const cat = pm.catalog();
try { out.listing = fs.readdirSync(path.join(appDir, 'plugins-catalog')); out.json = fs.readFileSync(path.join(appDir, 'plugins-catalog', 'demo-plugin', 'plugin.json'), 'utf8'); } catch (e) { out.listing = e.code || e.message; }
out.catalog = cat.map((p) => p.id);
try { out.installed = pm.install(cat.find((p) => p.id === 'demo-plugin').dir); } catch (e) { out.error = e.message; }
process.stdout.write(JSON.stringify(out));
`);
const r = spawnSync(ELECTRON, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
let out = {};
try { out = JSON.parse(r.stdout); } catch { console.log(r.stdout, r.stderr); }
check(out.cpSync && out.cpSync !== 'ok', `fs.cpSync cannot copy out of an asar here (${out.cpSync}), so this setup reproduces the report`);
if (JSON.stringify(out.catalog) !== '["demo-plugin"]') console.log('DIAG', JSON.stringify({ listing: out.listing, json: out.json, status: r.status, stderr: String(r.stderr).slice(0, 2000), archive: archive.length }));
check(JSON.stringify(out.catalog) === '["demo-plugin"]', `the Marketplace lists the plugin inside app.asar (${JSON.stringify(out.catalog)})`);
check(out.installed?.id === 'demo-plugin' && !out.error, `installing it from app.asar works (${out.error || JSON.stringify(out.installed)})`);
const target = path.join(userData, 'plugins', 'demo-plugin');
const read = (p) => { try { return readFileSync(path.join(target, p)); } catch { return null; } };
check(String(read('plugin.json')).includes('"demo-plugin"') && String(read('index.js')) === '// demo\n', 'plugin.json and index.js are copied');
check(String(read('locales/ko.json')).includes('데모 플러그인'), 'nested locales/ko.json is copied with its Korean text');
check(read('assets/deeper/icon.bin')?.equals(bytes), 'a binary file two folders deep is copied byte for byte');

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
