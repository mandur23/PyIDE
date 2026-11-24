// My Mods (main/minecraft/modmaker.js, renderer/features/minecraft/modmaker.js): first the rules on templates this test
// writes, then a Korean craft window whose template, versions and Gradle are stand-ins. No download, no real Gradle,
// JDK, game or launcher: a local web server plays Fabric's meta service and the example mod's repository, and the
// template's gradlew.bat is a Node script that writes the jars a build leaves.
// Checks: each loader's example mod renamed to the user's id, name, package and class (texts, package folders, files
// named after the id), a name that is not ASCII written for a .properties file, a name that holds the template's own
// left alone; the Java a build runs on, read from its files; the built jar told from its sources jar; a jar's mod id;
// where each loader's template comes from, NeoForge's older one included; a computer without a JDK gets Temurin's JDK
// of the Java the build needs, once (a stand-in for Adoptium serves a small zip); the page lists the mods; New Mod fills the
// id and the package from the name and says in Korean what it refuses; a mod is made, built in a Run tab with the JDK
// as JAVA_HOME, and its card says so; Add to lists the servers and instances of the mod's loader only, copies the jar
// and replaces an earlier build; a server's menu and an instance's Mods add a mod from their side; a mod file from
// elsewhere goes where its loader fits; Edit in Code starts Code on the mod's folder; a failed build is said and keeps
// the earlier jar; Cancel ends the build and the process it started. Plugins: a jar's plugin name and API; a Velocity
// and a Paper plugin written without a download, with the Eclipse files Code reads; New Plugin's refusals in Korean; a
// build refused until the server has unpacked its API; a real javac and jar build against stub API classes (the
// runner's JDK, as verify/minecraft.mjs uses it); the jar added to the Paper server; a compile error in javac's words;
// Add My Plugin in a plugin server's menu. Port 9780.
// Usage: node verify/craft-modmaker.mjs
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import http from 'http';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { closeBalloonsOver, craftMore, launch } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const M = require('../main/minecraft/modmaker.js');
const { writeZip } = require('../main/minecraft/zipfile.js');
let passed = 0;
let failed = 0;
const rule = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (ok) passed++; else failed++; };

const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-modmaker-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => readFileSync(p, 'utf8');
const zipOf = (entries) => writeZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : S(data)) })));

// ---------- the templates, as each loader's project writes them ----------
const FABRIC = {
  'gradle.properties': 'org.gradle.jvmargs=-Xmx1G\nminecraft_version=1.20.1\nloader_version=0.20.1\nloom_version=1.19-SNAPSHOT\nversion=1.0.0\ngroup=com.example\n',
  'build.gradle': 'plugins { id \'net.fabricmc.fabric-loom\' version "${loom_version}" }\ntasks.withType(JavaCompile).configureEach { it.options.release = 17 }\njava { sourceCompatibility = JavaVersion.VERSION_17 }\n',
  'settings.gradle': 'pluginManagement { }\n',
  'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.8.2-bin.zip\n',
  'src/main/java/com/example/ExampleMod.java': 'package com.example;\n\npublic class ExampleMod {\n\tpublic static final String MOD_ID = "modid";\n}\n',
  'src/main/java/com/example/mixin/ExampleMixin.java': 'package com.example.mixin;\n\npublic class ExampleMixin { }\n',
  'src/client/java/com/example/client/ExampleModClient.java': 'package com.example.client;\n\npublic class ExampleModClient { }\n',
  'src/client/resources/modid.client.mixins.json': '{ "package": "com.example.client.mixin" }\n',
  'src/main/resources/modid.mixins.json': '{ "package": "com.example.mixin" }\n',
  'src/main/resources/assets/modid/icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'src/main/resources/fabric.mod.json': S({ schemaVersion: 1, id: 'modid', version: '${version}', name: 'Example Mod', icon: 'assets/modid/icon.png',
    entrypoints: { main: ['com.example.ExampleMod'], client: ['com.example.client.ExampleModClient'] }, mixins: ['modid.mixins.json'] }, null, '\t'),
};
const NEOFORGE = {
  'gradle.properties': 'minecraft_version=26.2\nminecraft_version_range=[26.2]\nneo_version=26.2.0.50\nmod_id=examplemod\nmod_name=Example Mod\nmod_group_id=com.example.examplemod\n',
  'build.gradle': 'plugins { id \'net.neoforged.moddev\' version \'2.0.148\' }\njava.toolchain.languageVersion = JavaLanguageVersion.of(25)\n',
  'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.2.1-bin.zip\n',
  'src/main/java/com/example/examplemod/ExampleMod.java': 'package com.example.examplemod;\n\npublic class ExampleMod {\n    public static final String MODID = "examplemod";\n}\n',
  'src/main/java/com/example/examplemod/ExampleModClient.java': 'package com.example.examplemod;\n\npublic class ExampleModClient { }\n',
  'src/main/resources/assets/examplemod/lang/en_us.json': '{ "itemGroup.examplemod": "Example Mod Tab" }\n',
  'src/main/templates/META-INF/neoforge.mods.toml': '[[mods]]\nmodId="${mod_id}"\ndisplayName="${mod_name}"\n',
};
const FORGE = { ...NEOFORGE, 'build.gradle': 'java.toolchain.languageVersion = JavaLanguageVersion.of(17)\n', 'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.8-bin.zip\n' };
const lay = (dir, files) => { for (const [f, data] of Object.entries(files)) write(path.join(dir, f), data); return dir; };

// ---------- the rules ----------
{
  const fab = lay(path.join(work, 'rules', 'fabric'), FABRIC);
  M.renameMod(fab, 'fabric', { id: 'sky_tools', display: 'Sky Tools', pkg: 'io.me.skytools', cls: 'SkyTools' });
  const main = path.join(fab, 'src/main/java/io/me/skytools/SkyTools.java');
  const json = existsSync(path.join(fab, 'src/main/resources/fabric.mod.json')) ? JSON.parse(read(path.join(fab, 'src/main/resources/fabric.mod.json'))) : {};
  rule(existsSync(main) && /^package io\.me\.skytools;/.test(read(main)) && /MOD_ID = "sky_tools"/.test(read(main)) && /class SkyTools /.test(read(main))
    && existsSync(path.join(fab, 'src/client/java/io/me/skytools/client/SkyToolsClient.java')) && !existsSync(path.join(fab, 'src/main/java/com')),
  'a Fabric template\'s class, package and package folders become the user\'s, in every source set');
  rule(json.id === 'sky_tools' && json.name === 'Sky Tools' && S(json.entrypoints) === S({ main: ['io.me.skytools.SkyTools'], client: ['io.me.skytools.client.SkyToolsClient'] }) && S(json.mixins) === S(['sky_tools.mixins.json'])
    && existsSync(path.join(fab, 'src/main/resources/sky_tools.mixins.json')) && existsSync(path.join(fab, 'src/main/resources/assets/sky_tools/icon.png')) && existsSync(path.join(fab, 'src/client/resources/sky_tools.client.mixins.json'))
    && /^group=io\.me\.skytools$/m.test(read(path.join(fab, 'gradle.properties'))),
  `fabric.mod.json, the files named after the id and gradle.properties follow (${S([json.id, json.name, json.mixins])})`);

  const neo = lay(path.join(work, 'rules', 'neoforge'), NEOFORGE);
  M.renameMod(neo, 'neoforge', { id: 'examplemod_two', display: '하늘 도구', pkg: 'com.example.examplemod.two', cls: 'ExamplemodTwo' });
  const props = read(path.join(neo, 'gradle.properties'));
  const neoMain = path.join(neo, 'src/main/java/com/example/examplemod/two/ExamplemodTwo.java');
  rule(/^mod_id=examplemod_two$/m.test(props) && /^mod_group_id=com\.example\.examplemod\.two$/m.test(props) && props.includes('mod_name=\\ud558\\ub298 \\ub3c4\\uad6c')
    && existsSync(neoMain) && /^package com\.example\.examplemod\.two;/.test(read(neoMain)) && /MODID = "examplemod_two"/.test(read(neoMain))
    && read(path.join(neo, 'src/main/resources/assets/examplemod_two/lang/en_us.json')) === '{ "itemGroup.examplemod_two": "하늘 도구 Tab" }\n',
  'a NeoForge template: an id and a package that hold the template\'s own are written once, a Korean name is escaped in gradle.properties and written as it is in JSON');

  const jv = (files, loader, fb) => M.buildJava(lay(mkdtempSync(path.join(work, 'java-')), files), loader, fb);
  const loom = (v) => ({ ...FABRIC, 'gradle.properties': FABRIC['gradle.properties'].replace('1.19-SNAPSHOT', v) });
  rule(S(jv(FABRIC, 'fabric')) === S({ java: 25, upTo: 25 }) && S(jv(loom('1.13.6'), 'fabric')) === S({ java: 21, upTo: 25 }) && S(jv(loom('1.6-SNAPSHOT'), 'fabric')) === S({ java: 17, upTo: 25 })
    && S(jv(NEOFORGE, 'neoforge')) === S({ java: 25, upTo: 25 }) && S(jv(FORGE, 'forge')) === S({ java: 17, upTo: 17 }) && S(jv({ 'build.gradle': '' }, 'forge', 8)) === S({ java: 8, upTo: 8 }),
  'the Java a build runs on: Fabric\'s Loom 1.19 runs on 25 and 1.13 on 21 though the mod compiles for 17, a toolchain\'s version is the JDK, and a build that names none takes Minecraft\'s');

  const libs = path.join(work, 'rules', 'built', 'build', 'libs');
  write(path.join(libs, 'mod-1.0.0-sources.jar'), 'x');
  write(path.join(libs, 'mod-1.0.0-dev.jar'), 'x');
  rule(M.builtJar(path.dirname(path.dirname(libs))) === null, 'sources and development jars alone are no built mod');
  write(path.join(libs, 'mod-1.0.0.jar'), zipOf({ 'fabric.mod.json': { id: 'mod' } }));
  write(path.join(libs, 'forge.jar'), zipOf({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\n  modId = "forgy"\n' }));
  write(path.join(libs, 'plain.jar'), zipOf({ 'a.txt': 'x' }));
  rule(M.builtJar(path.dirname(path.dirname(libs)))?.name.endsWith('.jar') && S(M.modOfJar(path.join(libs, 'mod-1.0.0.jar'))) === S({ id: 'mod', loaders: ['fabric'] })
    && S(M.modOfJar(path.join(libs, 'forge.jar'))) === S({ id: 'forgy', loaders: ['forge', 'neoforge'] }) && M.modOfJar(path.join(libs, 'plain.jar')) === null,
  'a jar says the mod it holds and the loaders that read it; one without a descriptor is no mod');
  rule(M.classOf('sky_tools') === 'SkyTools' && M.classOf('a') === 'A' && M.MOD_ID.test('my_mod2') && !M.MOD_ID.test('My-Mod') && !M.MOD_ID.test('2mod') && !M.MOD_ID.test('..'), 'a mod id is lower case with digits and _, and its class is named from it');
  write(path.join(libs, 'shop.jar'), zipOf({ 'plugin.yml': 'name: "Shop"\nversion: 1.2\nmain: a.B\n' }));
  write(path.join(libs, 'land.jar'), zipOf({ 'paper-plugin.yml': '# a comment\nname: Land Claims # the name\nversion: 3\n' }));
  write(path.join(libs, 'hub.jar'), zipOf({ 'velocity-plugin.json': { id: 'hub', name: 'Hub', main: 'a.Hub' } }));
  rule(S(M.pluginOfJar(path.join(libs, 'shop.jar'))) === S({ id: 'Shop', api: 'paper' }) && S(M.pluginOfJar(path.join(libs, 'land.jar'))) === S({ id: 'Land Claims', api: 'paper' })
    && S(M.pluginOfJar(path.join(libs, 'hub.jar'))) === S({ id: 'hub', api: 'velocity' }) && M.pluginOfJar(path.join(libs, 'plain.jar')) === null && M.pluginOfJar(path.join(libs, 'mod-1.0.0.jar')) === null
    && M.PLUGIN_NAME.test('MyPlugin2') && !M.PLUGIN_NAME.test('myPlugin') && !M.PLUGIN_NAME.test('My_Plugin') && !M.PLUGIN_NAME.test('..'),
  'a jar says the plugin it holds and the API it is for (plugin.yml, paper-plugin.yml, velocity-plugin.json), and a plugin\'s name is a class name');
}

// ---------- the stand-in services ----------
// gradlew.bat as a Node script: `build` writes the mod's jar (named by gradle.properties' version) and its sources jar.
// A file named fail-build in the project fails the build; slow-build makes it start a child and wait, as Gradle does.
const fakeGradle = path.join(work, 'fake-gradle.cjs');
writeFileSync(fakeGradle, `const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { writeZip } = require(${S(path.resolve('main/minecraft/zipfile.js'))});
const args = process.argv.slice(2);
console.log('JAVA_HOME=' + process.env.JAVA_HOME);
console.log('GRADLE_OPTS=' + process.env.GRADLE_OPTS);
console.log('args ' + args.join(' '));
if (fs.existsSync('fail-build')) { console.error('src/main/java/Broken.java:3: error: 세미콜론이 없습니다'); console.error('BUILD FAILED'); process.exit(1); }
const finish = () => {
  const version = /^version=(.+)$/m.exec(fs.readFileSync('gradle.properties', 'utf8'))[1].trim();
  const meta = JSON.parse(fs.readFileSync('src/main/resources/fabric.mod.json', 'utf8'));
  fs.mkdirSync('build/libs', { recursive: true });
  fs.writeFileSync(path.join('build/libs', meta.id + '-' + version + '.jar'), writeZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ ...meta, version })) }]));
  fs.writeFileSync(path.join('build/libs', meta.id + '-' + version + '-sources.jar'), writeZip([{ name: 'a.txt', data: Buffer.from('x') }]));
  console.log('BUILD SUCCESSFUL');
};
if (fs.existsSync('slow-build')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('slow-build', String(child.pid));
  console.log('working');
  setInterval(() => {}, 1000);
} else finish();
`);
const template = zipOf(Object.fromEntries([...Object.entries(FABRIC), ['gradlew.bat', `@"${process.execPath}" "${fakeGradle}" %*\r\n`], ['gradlew', '#!/bin/sh\n']]
  .map(([name, data]) => [`fabric-example-mod-1.20.1/${name}`, data])));
const asked = [];
const server = http.createServer((req, res) => {
  asked.push(req.url);
  const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body); };
  if (req.url === '/fabric/versions/game') return send(S([{ version: '1.21.1', stable: true }, { version: '1.20.1', stable: true }, { version: '24w14a', stable: false }]));
  if (req.url === '/fabricMdk/archive/refs/heads/1.20.1.zip') return send(template, 'application/zip');
  if (req.url === '/forge/promos.json') return send(S({ promos: { '1.20.1-recommended': '47.4.0', '1.20.1-latest': '47.4.9', '1.21.1-latest': '52.1.0' } }));
  if (req.url === '/neoforge/maven-metadata.xml') return send('<metadata><versioning><versions><version>26.2.0.50</version><version>26.3.0.99</version><version>26.3.0.115</version><version>26.3.1.0-beta</version></versions></versioning></metadata>', 'text/xml');
  const more = routes.get(req.url);
  if (more) return send(more.body, more.type);
  res.writeHead(404);
  res.end('not here');
});
const routes = new Map(); // what a part below adds: address -> {body, type}
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const sources = { mojang: `${base}/manifest.json`, paper: `${base}/paper`, modrinth: `${base}/modrinth`, fabric: `${base}/fabric`, fabricMdk: `${base}/fabricMdk`, forge: `${base}/forge`, forgePromos: `${base}/forge/promos.json`,
  neoforge: `${base}/neoforge`, neoforgeMdk: `${base}/neoforgeMdk`, adoptium: `${base}/adoptium` };

// Where each loader's template comes from (sources.js modTemplate).
{
  process.env.PYIDE_MC_SOURCES = S(sources);
  const { modTemplate } = require('../main/minecraft/sources.js');
  const forge = await modTemplate('forge', '1.20.1');
  const latest = await modTemplate('forge', '1.21.1');
  const neo = await modTemplate('neoforge', '26.3');
  const fab = await modTemplate('fabric', '1.20.1');
  rule(forge.urls[0].url === `${base}/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-mdk.zip` && latest.urls[0].url.endsWith('/forge-1.21.1-52.1.0-mdk.zip') && fab.urls[0].url === `${base}/fabricMdk/archive/refs/heads/1.20.1.zip`,
    'Forge\'s template is the MDK of its recommended build (the latest when none is recommended), Fabric\'s the branch of that Minecraft version');
  rule(S(neo.urls.map((u) => [u.url.slice(base.length), u.mc])) === S([['/neoforgeMdk/MDK-26.3-ModDevGradle/archive/refs/heads/main.zip', '26.3'], ['/neoforgeMdk/MDK-26.3-NeoGradle/archive/refs/heads/main.zip', '26.3'],
    ['/neoforgeMdk/MDK-26.2-ModDevGradle/archive/refs/heads/main.zip', '26.2'], ['/neoforgeMdk/MDK-26.1-ModDevGradle/archive/refs/heads/main.zip', '26.1']]) && await neo.newest() === '26.3.0.115',
  'NeoForge\'s is the repository of that version, then the nearest older ones of its year, with the newest release build to point one of those at');
  rule(await modTemplate('quilt', '1.20.1').then(() => false, (e) => /Fabric, Forge or NeoForge/.test(e.message)) && await modTemplate('forge', '1.2.3').then(() => false, (e) => /Forge has no build for 1\.2\.3/.test(e.message)),
    'a loader mods are not made for, and a version Forge has no build for, are refused in words');
  delete process.env.PYIDE_MC_SOURCES;
}

// A build on a computer without a JDK (main/features/minecraft.js through its IPC handlers, Electron stood in for):
// Temurin's JDK of the Java the build asks for is downloaded once, checked, and is the build's JAVA_HOME.
{
  const jdkZip = zipOf({ 'jdk-25.0.1+8/bin/javac.exe': 'never run', 'jdk-25.0.1+8/bin/java.exe': 'never run', 'jdk-25.0.1+8/release': 'JAVA_VERSION="25.0.1"\n' });
  routes.set('/adoptium/assets/latest/25/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse', { type: 'application/json',
    body: S([{ binary: { package: { link: `${base}/files/OpenJDK25U-jdk_x64_windows.zip`, checksum: crypto.createHash('sha256').update(jdkZip).digest('hex'), size: jdkZip.length, name: 'OpenJDK25U-jdk_x64_windows.zip' } } }]) });
  routes.set('/files/OpenJDK25U-jdk_x64_windows.zip', { type: 'application/zip', body: jdkZip });
  const root = path.join(work, 'no-jdk');
  const none = path.join(work, 'no-toolchains.json');
  write(none, S({ system: false }));
  const own = { PYIDE_TRUST_ALL: '1', PYIDE_INSTALL_ROOT: path.join(root, 'install-root'), PYIDE_TOOLCHAINS: none, PYIDE_MC_SOURCES: S(sources) };
  Object.assign(process.env, own);
  const load = Module._load;
  const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => root, getAppPath: () => root, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : class {}) });
  Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
  const feature = require('../main/features/minecraft.js');
  Module._load = load;
  const handlers = new Map();
  const said = [];
  feature.register({ ipcMain: { handle: (h, fn) => handlers.set(h, fn), on() {} }, send: (_ch, m) => said.push(String(m?.text ?? '')), startProcess: () => 1, procs: new Map(), diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const project = path.join(root, 'project');
  const dir = lay(path.join(project, 'mods', 'core_mod'), { ...FABRIC, 'gradlew.bat': `@"${process.execPath}" "${fakeGradle}" %*\r\n` });
  write(path.join(dir, 'src/main/resources/fabric.mod.json'), S({ schemaVersion: 1, id: 'core_mod', name: 'Core Mod' }));
  write(path.join(dir, 'pyide-mod.json'), S({ id: 'core_mod', name: 'Core Mod', loader: 'fabric', mc: '1.20.1', pkg: 'com.example', cls: 'ExampleMod' }));
  const listed = await call('modmaker:list', project);
  const before = asked.length;
  const built = await call('modmaker:build', project, 'core_mod', 'job-1').catch((e) => ({ error: e.message }));
  const home = path.join(root, 'install-root', 'java', 'temurin-25-jdk', 'jdk-25.0.1+8');
  const jdkAsks = () => asked.slice(before).filter((u) => u.startsWith('/adoptium/') || u.startsWith('/files/'));
  rule(listed.length === 1 && listed[0].id === 'core_mod' && listed[0].jar === null && built.jar?.name === 'core_mod-1.0.0.jar' && built.java === 25 && existsSync(path.join(home, 'bin', 'javac.exe'))
    && said.join('').includes(`JAVA_HOME=${home}`) && said.join('').includes('downloading Temurin JDK 25') && S(jdkAsks()) === S(['/adoptium/assets/latest/25/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse', '/files/OpenJDK25U-jdk_x64_windows.zip']),
  `with no JDK on the computer, a build downloads Temurin's JDK (not the JRE) of the Java it needs and runs on it (${S([built.error || built.jar?.name, jdkAsks()])})`);
  const again = await call('modmaker:build', project, 'core_mod', 'job-2').catch((e) => ({ error: e.message }));
  rule(again.jar?.name === 'core_mod-1.0.0.jar' && jdkAsks().length === 2 && !readdirSync(path.join(root, 'install-root', 'java')).some((n) => /\.zip$|\.extract$/.test(n)),
    `the next build uses the JDK downloaded before, and neither its archive nor a half unpacked folder is left (${S(readdirSync(path.join(root, 'install-root', 'java')))})`);

  // A plugin for a Velocity proxy and one for a Paper server, written without a download; a build before the server
  // has its libraries, and with no server left, is refused in words.
  write(path.join(project, 'servers', 'proxy', 'pyide-server.json'), S({ kind: 'velocity', mc: '4.3.1', build: 45, java: 25, memory: '1G', launch: { jar: 'server.jar' } }));
  write(path.join(project, 'servers', 'proxy', 'server.properties'), 'server-port=25577\n');
  write(path.join(project, 'servers', 'proxy', 'server.jar'), zipOf({ 'a.txt': 'x' }));
  write(path.join(project, 'servers', 'lobby', 'pyide-server.json'), S({ kind: 'paper', mc: '26.3', build: 7, java: 25, memory: '2G', launch: { jar: 'server.jar' } }));
  write(path.join(project, 'servers', 'lobby', 'server.properties'), 'server-port=25565\n');
  const offered = await call('modmaker:pluginServers', project);
  const hub = await call('modmaker:createPlugin', project, { name: 'Hub', pkg: 'net.me.hub', server: 'proxy' });
  const gate = await call('modmaker:createPlugin', project, { name: 'Gate', pkg: 'net.me.gate', server: 'lobby' });
  const hubDir = path.join(project, 'plugins', 'Hub');
  const hubMain = path.join(hubDir, 'src/main/java/net/me/hub/Hub.java');
  const gateYml = path.join(project, 'plugins', 'Gate', 'src/main/resources/plugin.yml');
  rule(S(offered.map((s) => [s.name, s.api, s.ready])) === S([['lobby', 'paper', false], ['proxy', 'velocity', true]]) && hub.kind === 'plugin' && hub.api === 'velocity' && hub.against?.ready === true
    && existsSync(hubMain) && /^package net\.me\.hub;/.test(read(hubMain)) && /@Plugin\(id = "hub", name = "Hub"/.test(read(hubMain)) && JSON.parse(read(path.join(hubDir, 'src/main/resources/velocity-plugin.json'))).main === 'net.me.hub.Hub'
    && read(path.join(hubDir, '.classpath')).includes('servers/proxy/server.jar') && JSON.parse(read(path.join(hubDir, 'pyide-plugin.json'))).server === 'proxy',
  `a Velocity plugin is its main class and velocity-plugin.json, with the proxy's jar as its class path for Code (${S(offered)})`);
  rule(gate.api === 'paper' && gate.against?.name === 'lobby' && gate.against.ready === false && /^main: net\.me\.gate\.Gate$/m.test(read(gateYml)) && /^api-version: '26\.3'$/m.test(read(gateYml)) && /^ {2}gate:$/m.test(read(gateYml))
    && (await call('modmaker:list', project)).map((m) => `${m.kind}:${m.id}`).sort().join() === 'mod:core_mod,plugin:Gate,plugin:Hub',
  'a Paper plugin is its main class and plugin.yml for the server\'s Minecraft, and the list has the mods and the plugins');
  const said2 = async (...a) => { try { return await call(...a); } catch (e) { return e.message; } };
  const early = await said2('modmaker:build', project, { plugin: 'Gate' }, 'job-3');
  const twice = await said2('modmaker:createPlugin', project, { name: 'Gate', pkg: 'net.me.gate', server: 'lobby' });
  const noServer = await said2('modmaker:createPlugin', project, { name: 'Lost', pkg: 'net.me.lost', server: 'core_mod' });
  rule(/^Start lobby once first/.test(early) && /^A plugin named Gate already exists/.test(twice) && /^Choose a Paper, Purpur or Velocity server/.test(noServer) && !existsSync(path.join(project, 'plugins', 'Lost')),
    `a build before the server has unpacked its libraries, a second plugin of a name and a server that runs no plugins are refused (${S([early, twice, noServer])})`);
  for (const k of Object.keys(own)) delete process.env[k];
}

// ---------- in the app ----------
const serverDir = (n) => path.join(project, 'servers', n);
const fabricJar = (id, version) => zipOf({ 'fabric.mod.json': { schemaVersion: 1, id, version } });
write(path.join(serverDir('modded'), 'pyide-server.json'), S({ kind: 'fabric', mc: '1.20.1', loader: '0.15.0', build: null, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('modded'), 'server.properties'), 'server-port=25746\nmotd=modded\n');
write(path.join(serverDir('modded'), 'mods', 'other.jar'), fabricJar('other', '1.0'));
write(path.join(serverDir('newer'), 'pyide-server.json'), S({ kind: 'fabric', mc: '1.21.1', loader: '0.16.0', build: null, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('newer'), 'server.properties'), 'server-port=25747\n');
write(path.join(serverDir('forged'), 'pyide-server.json'), S({ kind: 'forge', mc: '1.20.1', loader: '47.4.0', build: null, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('forged'), 'server.properties'), 'server-port=25748\n');
write(path.join(serverDir('papery'), 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', build: 100, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('papery'), 'server.properties'), 'server-port=25749\n');
const instDir = (n) => path.join(project, 'instances', n);
write(path.join(instDir('survival'), 'nano-instance.json'), S({ title: '생존 월드', mc: '1.20.1', loader: 'fabric', loaderVersion: '0.15.0', memory: '4G', created: '2026-11-01T00:00:00.000Z' }));
write(path.join(instDir('quilted'), 'nano-instance.json'), S({ title: 'Quilted', mc: '1.20.1', loader: 'quilt', loaderVersion: '0.26.0', memory: '4G', created: '2026-11-02T00:00:00.000Z' }));
write(path.join(instDir('plain'), 'nano-instance.json'), S({ title: 'Plain', mc: '1.20.1', loader: 'vanilla', memory: '4G', created: '2026-11-03T00:00:00.000Z' }));
const outside = path.join(work, 'outside', 'forge-friend-2.0.jar');
write(outside, zipOf({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="friend"\nversion="2.0"\n' }));
// A real JDK, for the plugin's javac and jar (the mods' Gradle is a stand-in that only prints its JAVA_HOME).
const java = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME
  || path.dirname(path.dirname(execFileSync('where', ['javac'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()));
// What a Paper server unpacks at its first start, as far as the plugin's first lines need it: stub classes of the API.
const apiSrc = path.join(work, 'api-src');
const stubs = {
  'org/bukkit/plugin/java/JavaPlugin.java': 'package org.bukkit.plugin.java; public abstract class JavaPlugin { public void onEnable() {} public org.bukkit.Server getServer() { return null; } public java.util.logging.Logger getLogger() { return null; } public boolean onCommand(org.bukkit.command.CommandSender s, org.bukkit.command.Command c, String l, String[] a) { return false; } }',
  'org/bukkit/Server.java': 'package org.bukkit; public interface Server { org.bukkit.plugin.PluginManager getPluginManager(); }',
  'org/bukkit/plugin/PluginManager.java': 'package org.bukkit.plugin; public interface PluginManager { void registerEvents(org.bukkit.event.Listener l, org.bukkit.plugin.java.JavaPlugin p); }',
  'org/bukkit/event/Listener.java': 'package org.bukkit.event; public interface Listener {}',
  'org/bukkit/event/EventHandler.java': 'package org.bukkit.event; import java.lang.annotation.*; @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD) public @interface EventHandler {}',
  'org/bukkit/event/player/PlayerJoinEvent.java': 'package org.bukkit.event.player; public class PlayerJoinEvent { public org.bukkit.entity.Player getPlayer() { return null; } }',
  'org/bukkit/entity/Player.java': 'package org.bukkit.entity; public interface Player extends org.bukkit.command.CommandSender {}',
  'org/bukkit/command/CommandSender.java': 'package org.bukkit.command; public interface CommandSender { void sendMessage(String m); }',
  'org/bukkit/command/Command.java': 'package org.bukkit.command; public class Command {}',
};
for (const [f, text] of Object.entries(stubs)) write(path.join(apiSrc, f), text);
const apiJar = path.join(work, 'paper-api.jar');
mkdirSync(path.join(work, 'api-classes'), { recursive: true });
execFileSync(path.join(java, 'bin', 'javac.exe'), ['--release', '17', '-d', path.join(work, 'api-classes'), ...Object.keys(stubs).map((f) => path.join(apiSrc, f))]);
execFileSync(path.join(java, 'bin', 'jar.exe'), ['--create', '--file', apiJar, '-C', path.join(work, 'api-classes'), '.']);
const codeLog = path.join(work, 'code-launch.json');
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java, PYIDE_MC_CODE: codeLog, PYIDE_MC_SOURCES: S(sources) };

const t = await launch({ name: 'craft-modmaker', port: 9780, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, type, sleep } = t;
// The balloons of the steps before pile up at the lower right, over what a 1024x720 window (CI's) has there: the ones
// over an element are closed with their x before it is pressed.
const click = async (selector) => { await closeBalloonsOver(t, `document.querySelector(${S(selector)})`); await t.click(selector); };
const PAGE = `document.querySelector('.mcw-page')`;
const card = (id) => `${PAGE}.querySelector('.mcw-card[data-id="${id}"]')`;
const cardView = (id) => js(`(() => { const c = ${card(id)}; return c && { name: c.querySelector('.mcc-name').textContent, chips: [...c.querySelectorAll('.mcc-chip')].map((x) => x.textContent), facts: [...c.querySelectorAll('.mcc-facts > span')].map((x) => x.textContent),
  build: [c.querySelector('.mcw-build > span:last-child').textContent, c.querySelector('.mcw-build').disabled], add: c.querySelector('.mcw-add').disabled }; })()`);
const DIALOG = `[...document.querySelectorAll('.dialog')].pop()`;
const dialogButton = (label) => `[...${DIALOG}.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
const noDialog = () => until(`!document.querySelector('.dialog')`, 'the dialog closed', 8000);
const notes = () => js(`ide.notifications.list().map((e) => [e.title, e.text || ''])`);
const runTab = (title) => js(`(ide.run.sessions().find((s) => s.title === ${S(title)})?.host.textContent) || ''`);
const modDir = path.join(project, 'mods', 'sky_tools');
const modsOf = (dir) => (existsSync(path.join(dir, 'mods')) ? readdirSync(path.join(dir, 'mods')).sort() : []);
const places = () => js(`[...${DIALOG}.querySelectorAll('.mcw-place')].map((r) => [r.dataset.type, r.dataset.name, r.querySelector('input').checked, [...r.querySelectorAll('.mcc-chip, .mcw-place-why')].map((x) => x.textContent)])`);
const alive = (pid) => { try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid)); } catch { return false; } };
try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 20000);
  await js('ide.minecraft.refresh()');
  await until(`ide.minecraft.servers().length === 4`, 'the servers in the list', 10000);

  // ---------- the page ----------
  const nav = await js(`[...document.querySelectorAll('.mcs-nav .mcs-page')].map((b) => [b.dataset.page, b.querySelector(':scope > span:last-child').textContent])`);
  check(S(nav) === S([['play', '플레이'], ['join', '서버 참여'], ['servers', '내 서버'], ['mods', '내 모드·플러그인'], ['market', '마켓']]), `the list on the left has My Mods and Plugins (${S(nav)})`);
  await click('.mcs-nav .mcs-page[data-page="mods"]');
  await until(`!${PAGE}.classList.contains('hidden') && !!${PAGE}.querySelector('.mcc-empty-title')`, 'the empty page', 8000);
  const empty = await js(`[${PAGE}.querySelector('.mcc-title').textContent, ${PAGE}.querySelector('.mcc-empty-title').textContent, [...${PAGE}.querySelectorAll('.mcc-tools button')].map((b) => b.querySelector(':scope > span:last-child').textContent)]`);
  check(S(empty) === S(['내 모드·플러그인', '아직 만든 것이 없어요', ['새 모드…', '새 플러그인…', '파일 추가…']]), `with nothing made yet the page says so and offers New Mod, New Plugin and Add a File (${S(empty)})`);

  // ---------- New Mod ----------
  await click('.mcw-new');
  await until(`!!document.querySelector('#mcwName') && document.querySelector('#mcwVersion').options.length === 2`, 'the dialog with Fabric\'s versions', 10000)
    .catch(async (e) => { console.log(await js(`[!!document.querySelector('.dialog'), document.querySelector('#mcwVersion')?.outerHTML, document.querySelector('.dialog .mc-dialog-error')?.textContent, document.querySelector('.mcw-new')?.outerHTML]`)); throw e; });
  check(S(await js(`[...document.querySelector('#mcwVersion').options].map((o) => o.value)`)) === S(['1.21.1', '1.20.1']) && S(await js(`[...document.querySelector('#mcwLoader').options].map((o) => o.textContent)`)) === S(['Fabric', 'Forge', 'NeoForge']),
    'New Mod offers the three loaders and the stable Minecraft versions of the one chosen');
  await click('#mcwName');
  await type('Sky Tools!');
  const filled = await js(`[document.querySelector('#mcwId').value, document.querySelector('#mcwPackage').value]`);
  check(S(filled) === S(['sky_tools', 'com.example.sky_tools']), `the mod id and the package follow the name as it is typed (${S(filled)})`);
  await js(`(() => { const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('input')); }; set('#mcwId', 'Sky-Tools'); return true; })()`);
  await js(`(${dialogButton('생성')}).click()`);
  const badId = await js(`${DIALOG}.querySelector('.mc-dialog-error').textContent`);
  await js(`(() => { const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('input')); }; set('#mcwId', 'sky_tools'); set('#mcwPackage', 'class.tools'); return true; })()`);
  await js(`(${dialogButton('생성')}).click()`);
  const badPkg = await js(`${DIALOG}.querySelector('.mc-dialog-error').textContent`);
  check(/^모드 ID는 영어 소문자로 시작하고/.test(badId) && /^패키지는 com\.example\.mymod처럼/.test(badPkg) && !existsSync(modDir), `a mod id and a package main would refuse are said in the dialog, in Korean, and nothing is made (${S([badId, badPkg])})`);
  await js(`(() => { const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('input')); }; set('#mcwPackage', 'io.me.skytools'); document.querySelector('#mcwVersion').value = '1.20.1'; return true; })()`);
  await shot('new-mod.png');
  await js(`(${dialogButton('생성')}).click()`);
  await until(`!!${card('sky_tools')}`, 'the mod\'s card', 30000).catch(async (e) => { console.log(await runTab('Minecraft: 새 모드')); throw e; });
  const meta = existsSync(path.join(modDir, 'pyide-mod.json')) ? JSON.parse(read(path.join(modDir, 'pyide-mod.json'))) : {};
  const mainClass = path.join(modDir, 'src', 'main', 'java', 'io', 'me', 'skytools', 'SkyTools.java');
  check(existsSync(mainClass) && /MOD_ID = "sky_tools"/.test(read(mainClass)) && JSON.parse(read(path.join(modDir, 'src/main/resources/fabric.mod.json'))).name === 'Sky Tools!' && existsSync(path.join(modDir, 'gradlew.bat'))
    && S([meta.id, meta.name, meta.loader, meta.mc, meta.pkg, meta.cls, meta.java]) === S(['sky_tools', 'Sky Tools!', 'fabric', '1.20.1', 'io.me.skytools', 'SkyTools', 25]) && !existsSync(`${modDir}.download`),
  `the mod is the template under the user's names, described by pyide-mod.json, and the download's folder is gone (${S(meta)})`);
  const made = await cardView('sky_tools');
  check(made.name === 'Sky Tools!' && S(made.chips) === S(['Minecraft 1.20.1', 'Fabric', '아직 빌드 안 함']) && S(made.build) === S(['빌드', false]) && made.add === true && made.facts[0] === 'sky_tools',
    `its card names it, its loader and version, and that it is not built: Build is on, Add to is off (${S(made)})`);
  check((await notes()).some((n) => n[0] === 'Sky Tools! 모드를 만들었어요' && n[1] === 'Fabric · Minecraft 1.20.1'), 'a notification says the mod was made');
  check(asked.includes('/fabricMdk/archive/refs/heads/1.20.1.zip'), 'the template asked for is the example mod\'s branch of that version');

  // ---------- a mod id taken already ----------
  await click('.mcw-new');
  await until(`!!document.querySelector('#mcwName') && document.querySelector('#mcwVersion').options.length === 2`, 'the dialog again', 10000);
  await click('#mcwName');
  await type('sky tools');
  await js(`(${dialogButton('생성')}).click()`);
  check(await js(`${DIALOG}.querySelector('.mc-dialog-error').textContent`) === '모드 ID가 sky_tools인 모드가 이미 있어요.', 'a second mod of the same id is refused in the dialog');
  await js(`(${dialogButton('취소')}).click()`);
  await noDialog();

  // ---------- Build ----------
  await click(`.mcw-card[data-id="sky_tools"] .mcw-build`);
  await until(`${card('sky_tools')}?.querySelector('.mcw-state.built')`, 'the card says Built', 30000).catch(async (e) => { console.log(await runTab('Minecraft: Sky Tools! 빌드')); throw e; });
  const log = await runTab('Minecraft: Sky Tools! 빌드');
  check(log.includes(`JAVA_HOME=${java}`) && log.includes('args --console=plain --no-daemon build') && /GRADLE_OPTS=.*-Dstdout\.encoding=UTF-8/.test(log) && log.includes('gradlew build with Java 25') && log.includes('sky_tools-1.0.0.jar 파일을 만들었어요'),
    `the build is the mod's own gradlew, with the JDK as JAVA_HOME and UTF-8 output, shown in a Run tab (${S(log.slice(0, 300))})`);
  const built = await cardView('sky_tools');
  check(S(built.chips) === S(['Minecraft 1.20.1', 'Fabric', '빌드됨']) && built.facts[1] === 'sky_tools-1.0.0.jar' && built.add === false && S(built.build) === S(['빌드', false]),
    `the card names the jar that was built, not its sources jar, and Add to is on (${S(built)})`);
  check((await notes()).some((n) => n[0] === 'Sky Tools! 빌드를 마쳤어요' && n[1] === 'sky_tools-1.0.0.jar'), 'a notification says the build is done');
  await shot('my-mods.png');

  // ---------- Add to ----------
  await click(`.mcw-card[data-id="sky_tools"] .mcw-add`);
  await until(`${DIALOG}?.querySelectorAll('.mcw-place').length === 4`, 'the places of the mod\'s loader', 8000);
  const first = await places();
  check(S(first.map((p) => [p[0], p[1]])) === S([['server', 'modded'], ['server', 'newer'], ['instance', 'quilted'], ['instance', 'survival']]) || S(first.map((p) => p[1]).sort()) === S(['modded', 'newer', 'quilted', 'survival']),
    `Add to lists the Fabric servers and the Fabric and Quilt instances, not the Forge or Paper server or the vanilla instance (${S(first.map((p) => [p[0], p[1]]))})`);
  const newer = first.find((p) => p[1] === 'newer');
  check(first.every((p) => p[2] === false) && S(newer[3]) === S(['서버', 'Minecraft 1.21.1', '마인크래프트 버전이 달라서 모드가 안 열릴 수 있어요']) && S(first.find((p) => p[1] === 'survival')[3]) === S(['인스턴스', 'Minecraft 1.20.1']),
    `nothing is chosen for the user, and a place of another Minecraft version says the mod may not load (${S(newer)})`);
  await js(`(${dialogButton('추가')}).click()`);
  check(await js(`${DIALOG}.querySelector('.mc-dialog-error').textContent`) === '추가할 곳을 골라 주세요.', 'Add with nothing chosen asks where');
  await shot('add-to.png');
  await click('.mcw-place[data-name="modded"] input');
  await click('.mcw-place[data-name="survival"] input');
  await js(`(${dialogButton('추가')}).click()`);
  await noDialog();
  check(S(modsOf(serverDir('modded'))) === S(['other.jar', 'sky_tools-1.0.0.jar']) && S(modsOf(instDir('survival'))) === S(['sky_tools-1.0.0.jar']) && !modsOf(serverDir('newer')).length && !modsOf(instDir('quilted')).length,
    `the jar is copied into the mods folders chosen, and nowhere else (${S([modsOf(serverDir('modded')), modsOf(instDir('survival'))])})`);
  const addedNote = (await notes()).find((n) => n[0] === 'sky_tools-1.0.0.jar 파일을 2곳에 추가했어요');
  check(!!addedNote && /modded: 추가함/.test(addedNote[1]) && /생존 월드: 추가함/.test(addedNote[1]), `a notification names where it went (${S(addedNote)})`);

  // ---------- a newer build replaces the earlier one ----------
  write(path.join(modDir, 'gradle.properties'), read(path.join(modDir, 'gradle.properties')).replace('version=1.0.0', 'version=1.1.0'));
  await click(`.mcw-card[data-id="sky_tools"] .mcw-build`);
  await until(`(${card('sky_tools')}?.querySelector('.mcw-jar')?.textContent) === 'sky_tools-1.1.0.jar'`, 'the newer jar on the card', 30000);
  await click(`.mcw-card[data-id="sky_tools"] .mcw-add`);
  await until(`${DIALOG}?.querySelectorAll('.mcw-place').length === 4`, 'the places again', 8000);
  const second = await places();
  check(S(second.filter((p) => p[2]).map((p) => p[1]).sort()) === S(['modded', 'survival']) && second.find((p) => p[1] === 'modded')[3].includes('이미 있음: 새 파일로 바꿔요'),
    `the places that have the mod are chosen, and say it is replaced (${S(second.filter((p) => p[2]))})`);
  await js(`(${dialogButton('추가')}).click()`);
  await noDialog();
  check(S(modsOf(serverDir('modded'))) === S(['other.jar', 'sky_tools-1.1.0.jar']) && S(modsOf(instDir('survival'))) === S(['sky_tools-1.1.0.jar']),
    `the earlier build of the same mod, under another file name, is gone and the other mods stay (${S(modsOf(serverDir('modded')))})`);
  check((await notes()).some((n) => n[0] === 'sky_tools-1.1.0.jar 파일을 2곳에 추가했어요' && /modded: 새 파일로 바꿈/.test(n[1])), 'the notification says it was replaced');

  // ---------- from a server's menu and an instance's Mods ----------
  await click('.mcs-nav .mcs-page[data-page="servers"]');
  await until(`!!document.querySelector('.mc-server[data-name="newer"] .mc-more')`, 'the server cards', 8000);
  check((await js(`document.querySelector('.mc-server[data-name="newer"]').dataset.more`)).split(' ').includes('mc-my-mod') && !(await js(`document.querySelector('.mc-server[data-name="papery"]').dataset.more`)).split(' ').includes('mc-my-mod'),
    'a server that runs mods has Add My Mod in its menu, a Paper server has not');
  await js(craftMore(`document.querySelector('.mc-server[data-name="newer"]')`, 'mc-my-mod'));
  await until(`${DIALOG}?.querySelectorAll('.mcw-mine').length === 1`, 'my mods for the server', 8000);
  const mine = await js(`[${DIALOG}.querySelector('.dialog-title').textContent, [...${DIALOG}.querySelectorAll('.mcw-mine')].map((r) => [r.dataset.id, r.querySelector('.mcw-place-name').textContent, r.querySelector('.mcc-chip').className.includes('bad'), r.querySelector('.mcw-mine-add').disabled])]`);
  check(S(mine) === S(['newer에 내 모드 추가', [['sky_tools', 'Sky Tools!', true, false]]]), `it lists the user's mods of the server's loader, marking another Minecraft version (${S(mine)})`);
  await js(`(${DIALOG}.querySelector('.mcw-mine-add').click(), true)`);
  await until(`${DIALOG}?.querySelectorAll('label.mcw-place').length === 1`, 'the one place', 8000);
  check(S((await places()).map((p) => [p[1], p[2]])) === S([['newer', true]]), 'asked from one server, that server alone is offered, chosen');
  await js(`(${dialogButton('추가')}).click()`);
  await noDialog();
  check(S(modsOf(serverDir('newer'))) === S(['sky_tools-1.1.0.jar']), 'and the mod is added there');

  // ---------- a mod file from elsewhere ----------
  await js(`(ide.minecraft.modmaker.addDialog({ file: ${S(outside)} }), true)`);
  await until(`${DIALOG}?.querySelectorAll('label.mcw-place').length === 1`, 'the places of the file\'s loader', 8000);
  const file = await js(`[${DIALOG}.querySelector('.mcw-add-file-name').textContent, [...${DIALOG}.querySelectorAll('.mcw-place')].map((r) => r.dataset.name)]`);
  check(S(file) === S(['forge-friend-2.0.jar', ['forged']]), `a Forge mod made elsewhere is offered to the Forge server only (${S(file)})`);
  await js(`(${dialogButton('추가')}).click()`);
  await noDialog();
  check(S(modsOf(serverDir('forged'))) === S(['forge-friend-2.0.jar']), 'and copied into its mods');
  await js(`(ide.minecraft.modmaker.addDialog({ file: ${S(path.join(modDir, 'gradlew.bat'))} }), true)`);
  await until(`!!document.querySelector('.dialog .dialog-message, .dialog .dialog-body')`, 'the refusal', 8000);
  check(/모드의 \.jar|jar/.test(await js(`${DIALOG}.querySelector('.dialog-body').textContent`)), 'a file that is no jar is refused');
  await js(`(${DIALOG}.querySelector('.dialog-buttons button').click(), true)`);
  await noDialog();

  // ---------- Edit in Code ----------
  await click('.mcs-nav .mcs-page[data-page="mods"]');
  await until(`!!${card('sky_tools')}`, 'the page again', 8000);
  await click(`.mcw-card[data-id="sky_tools"] .mcw-code`);
  await until(`ide.notifications.list().some((e) => e.title === 'Nano Studio Code에서 Sky Tools! 여는 중')`, 'the notification', 8000);
  const code = existsSync(codeLog) ? JSON.parse(read(codeLog)) : {};
  check(S(code.argv) === S(['--mode=code', modDir]), `Edit in Code starts Nano Studio in code mode with the mod's folder (${S(code)})`);

  // ---------- a build that fails ----------
  write(path.join(modDir, 'fail-build'), '');
  await click(`.mcw-card[data-id="sky_tools"] .mcw-build`);
  await until(`ide.notifications.list().some((e) => e.title === 'Sky Tools! 빌드에 실패했어요')`, 'the failure said', 30000);
  const failNote = (await notes()).find((n) => n[0] === 'Sky Tools! 빌드에 실패했어요');
  const failLog = await runTab('Minecraft: Sky Tools! 빌드');
  check(/^빌드에 실패했어요\. 실행 탭에/.test(failNote[1]) && failLog.includes('세미콜론이 없습니다') && failLog.includes('BUILD FAILED'), `a failed build is said in Korean, and the Run tab has the compiler's own words, Korean ones too (${S(failNote)})`);
  await until(`${card('sky_tools')}?.querySelector('.mcw-build')?.disabled === false`, 'the card back', 8000);
  check((await cardView('sky_tools')).facts[1] === 'sky_tools-1.1.0.jar', 'the jar of the build before stays the mod\'s file');
  execFileSync('cmd', ['/c', 'del', path.join(modDir, 'fail-build')]);

  // ---------- Cancel ----------
  write(path.join(modDir, 'slow-build'), '');
  await click(`.mcw-card[data-id="sky_tools"] .mcw-build`);
  await until(`(ide.run.sessions().find((s) => s.title === 'Minecraft: Sky Tools! 빌드')?.host.textContent || '').includes('working')`, 'the build working', 20000);
  const working = await cardView('sky_tools');
  const child = Number(read(path.join(modDir, 'slow-build')));
  check(S(working.build) === S(['빌드 중…', true]) && working.add === true && working.chips.includes('빌드 중') && child > 0 && alive(child), `while it builds the card says so and takes no second Build (${S(working)})`);
  await js(`(() => { const n = ide.notifications.list().findLast((e) => e.title === 'Sky Tools! 빌드 중…'); n.actions.find((a) => a.label === '취소').run(n); return true; })()`);
  await until(`${card('sky_tools')}?.querySelector('.mcw-build')?.disabled === false`, 'the build ended', 15000);
  for (let i = 0; i < 20 && alive(child); i++) await sleep(250);
  check(!alive(child), 'Cancel ends the build and the process it started, not cmd.exe alone');
  check(!(await notes()).some((n) => n[0] === 'Sky Tools! 빌드에 실패했어요' && /취소/.test(n[1])) && (await cardView('sky_tools')).facts[1] === 'sky_tools-1.1.0.jar', 'a cancelled build is no failure, and the mod\'s file stays');

  // ---------- a plugin ----------
  const pluginDir = path.join(project, 'plugins', 'HelloCraft');
  const pluginsOf = (n) => (existsSync(path.join(serverDir(n), 'plugins')) ? readdirSync(path.join(serverDir(n), 'plugins')).sort() : []);
  const pcard = `${PAGE}.querySelector('.mcw-card[data-kind="plugin"][data-id="HelloCraft"]')`;
  await click('.mcw-new-plugin');
  await until(`!!document.querySelector('#mcwPluginName')`, 'the New Plugin dialog', 8000);
  const offered = await js(`[[...document.querySelector('#mcwPluginServer').options].map((o) => o.textContent), ${DIALOG}.querySelector('.mc-dialog-note').textContent]`);
  check(S(offered[0]) === S(['papery · Paper 1.20.1']) && /^빌드하기 전에 papery 서버를 한 번 시작하세요/.test(offered[1]),
    `New Plugin offers the servers that run plugins, and says a server that has not started yet must start once before a build (${S(offered)})`);
  await click('#mcwPluginName');
  await type('hello craft');
  await js(`(${dialogButton('생성')}).click()`);
  const badName = await js(`${DIALOG}.querySelector('.mc-dialog-error').textContent`);
  await js(`(() => { const i = document.querySelector('#mcwPluginName'); i.value = 'HelloCraft'; i.dispatchEvent(new Event('input')); return true; })()`);
  const pkgFilled = await js(`document.querySelector('#mcwPluginPackage').value`);
  check(/^이름은 MyPlugin처럼 영어 대문자로 시작하고/.test(badName) && pkgFilled === 'com.example.hellocraft' && !existsSync(pluginDir), `a name that is no class name is refused in Korean, and the package follows the name (${S([badName, pkgFilled])})`);
  await shot('new-plugin.png');
  await js(`(${dialogButton('생성')}).click()`);
  await until(`!!${pcard}`, 'the plugin\'s card', 10000);
  const pmain = path.join(pluginDir, 'src', 'main', 'java', 'com', 'example', 'hellocraft', 'HelloCraft.java');
  const pview = () => js(`(() => { const c = ${pcard}; return { chips: [...c.querySelectorAll('.mcc-chip')].map((x) => x.textContent), facts: [...c.querySelectorAll('.mcc-facts > span')].map((x) => x.textContent), add: c.querySelector('.mcw-add').disabled }; })()`);
  const fresh = await pview();
  check(existsSync(pmain) && /extends JavaPlugin/.test(read(pmain)) && /^main: com\.example\.hellocraft\.HelloCraft$/m.test(read(path.join(pluginDir, 'src/main/resources/plugin.yml')))
    && S(fresh.chips) === S(['Paper 플러그인', '아직 빌드 안 함']) && S(fresh.facts) === S(['papery 서버로 빌드', 'papery 서버를 한 번 시작한 뒤 빌드하세요.']) && fresh.add === true,
  `the plugin is written without a download, and its card names its API, its server and what a build waits for (${S(fresh)})`);
  await click(`.mcw-card[data-id="HelloCraft"] .mcw-build`);
  await until(`ide.notifications.list().some((e) => e.title === 'HelloCraft 빌드에 실패했어요')`, 'the refusal', 15000);
  check(/^papery 서버를 먼저 한 번 시작하세요/.test((await notes()).findLast((n) => n[0] === 'HelloCraft 빌드에 실패했어요')[1]), 'a build before the server has its libraries says to start the server once');
  // The server's first start, as far as a build needs it.
  write(path.join(serverDir('papery'), 'libraries', 'io', 'papermc', 'paper', 'paper-api', 'stub', 'paper-api.jar'), readFileSync(apiJar));
  await until(`${pcard}?.querySelector('.mcw-build')?.disabled === false`, 'the card back', 8000);
  await click(`.mcw-card[data-id="HelloCraft"] .mcw-build`);
  await until(`${pcard}?.querySelector('.mcw-state.built')`, 'the plugin built', 60000).catch(async (e) => { console.log(await runTab('Minecraft: HelloCraft 빌드')); throw e; });
  const plog = await runTab('Minecraft: HelloCraft 빌드');
  const pjar = path.join(pluginDir, 'build', 'libs', 'HelloCraft.jar');
  const entries = existsSync(pjar) ? execFileSync(path.join(java, 'bin', 'jar.exe'), ['--list', '--file', pjar], { encoding: 'utf8' }).split(/\r?\n/) : [];
  check(/javac --release 17 against papery \(1 file/.test(plog) && entries.includes('plugin.yml') && entries.includes('com/example/hellocraft/HelloCraft.class') && S((await pview()).facts.slice(0, 2)) === S(['papery 서버로 빌드', 'HelloCraft.jar']),
    `Build compiles it with javac for the server's Java against the server's API and packs the classes with plugin.yml (${S(entries.filter(Boolean))})`);
  const classpath = read(path.join(pluginDir, '.classpath'));
  check(classpath.includes('servers/papery/libraries/io/papermc/paper/paper-api/stub/paper-api.jar') && classpath.includes('path="src/main/java"') && /compliance=17/.test(read(path.join(pluginDir, '.settings', 'org.eclipse.jdt.core.prefs'))),
    'the Eclipse files that give Code the plugin\'s class path name the server\'s API and Java');
  await click(`.mcw-card[data-id="HelloCraft"] .mcw-add`);
  await until(`${DIALOG}?.querySelectorAll('label.mcw-place').length === 1`, 'the servers that take the plugin', 8000);
  const pplaces = await places();
  check(S(pplaces) === S([['server', 'papery', true, ['서버', 'Paper 1.20.1']]]) && await js(`${DIALOG}.querySelector('.dialog-title').textContent`) === '플러그인 추가'
    && S(await js(`[...${DIALOG}.querySelectorAll('.mcw-add-file .mcc-chip')].map((x) => x.textContent)`)) === S(['Paper 플러그인']),
  `Add to offers a Paper plugin to the Paper server only, its own server chosen (${S(pplaces)})`);
  await js(`(${dialogButton('추가')}).click()`);
  await noDialog();
  check(S(pluginsOf('papery')) === S(['HelloCraft.jar']) && !pluginsOf('modded').length && (await notes()).some((n) => n[0] === 'HelloCraft.jar 파일을 1곳에 추가했어요'), `the jar goes into the server's plugins folder (${S(pluginsOf('papery'))})`);
  // A compile error is javac's own words in the Run tab, and the jar of the build before stays.
  const good = read(pmain);
  write(pmain, good.replace('getLogger().info("HelloCraft enabled");', 'getLogger().info("HelloCraft enabled")'));
  await click(`.mcw-card[data-id="HelloCraft"] .mcw-build`);
  await until(`ide.notifications.list().filter((e) => e.title === 'HelloCraft 빌드에 실패했어요').length === 2`, 'the compile error said', 60000);
  const elog = await runTab('Minecraft: HelloCraft 빌드');
  check(/HelloCraft\.java:\d+: /.test(elog) && /^빌드에 실패했어요\. 실행 탭에/.test((await notes()).findLast((n) => n[0] === 'HelloCraft 빌드에 실패했어요')[1]) && existsSync(pjar),
    `a compile error shows javac's message with the file and line, and the earlier jar stays (${S(elog.slice(0, 300))})`);
  write(pmain, good);
  await click('.mcs-nav .mcs-page[data-page="servers"]');
  await until(`!!document.querySelector('.mc-server[data-name="papery"] .mc-more')`, 'the server cards', 8000);
  const menus = await js(`['papery', 'modded'].map((n) => document.querySelector('.mc-server[data-name="' + n + '"]').dataset.more.split(' ').filter((c) => c === 'mc-my-plugin' || c === 'mc-my-mod'))`);
  check(S(menus) === S([['mc-my-plugin'], ['mc-my-mod']]), `a server that runs plugins has Add My Plugin in its menu, one that runs mods Add My Mod (${S(menus)})`);
  // The balloons of the steps before lie over the lower cards' More buttons: the menu's row is pressed as lib.mjs does.
  await js(craftMore(`document.querySelector('.mc-server[data-name="papery"]')`, 'mc-my-plugin'));
  await until(`${DIALOG}?.querySelectorAll('.mcw-mine').length === 1`, 'my plugins for the server', 8000);
  const minePlugins = await js(`[${DIALOG}.querySelector('.dialog-title').textContent, [...${DIALOG}.querySelectorAll('.mcw-mine')].map((r) => [r.dataset.id, r.querySelector('.mcw-mine-add').disabled])]`);
  check(S(minePlugins) === S(['papery에 내 플러그인 추가', [['HelloCraft', false]]]), `it lists the user's plugins for that server's API, not their mods (${S(minePlugins)})`);
  await js(`(${dialogButton('닫기')}).click()`);
  await noDialog();
  await click('.mcs-nav .mcs-page[data-page="mods"]');
  await until(`!!${pcard}`, 'the page again', 8000);
  await shot('mods-and-plugins.png');

  // ---------- nothing left in English, in both themes ----------
  const english = await js(`[...${PAGE}.querySelectorAll('.mcc-title, .mcc-sub, .mcc-tools button, .mcw-card .mcc-chip, .mcw-card button, .mcw-card .mcc-facts > span:not(.mcw-id):not(.mcw-jar):not(.mcw-against):not(.mcw-start-first)')].map((n) => n.textContent || n.title).filter((x) => /[A-Za-z]{4,}/.test(x.replace(/Minecraft|Fabric|Forge|NeoForge|Nano Studio Code|Gradle|Paper|Velocity/g, '')))`);
  check(!english.length, `nothing of the page's own words is left in English (${S(english)})`);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`).catch(() => {});
  await sleep(400);
  await shot('my-mods-light.png');
  check(!t.consoleErrors.length, `no renderer exceptions ${S(t.consoleErrors)}`);
} catch (err) {
  check(false, `craft-modmaker crashed: ${err.stack || err}`);
}
server.close();
if (failed) process.exitCode = 1;
console.log(`rules: ${passed}/${passed + failed} passed`);
t.finish();
