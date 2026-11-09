// Spring Boot configuration files (spring-config plugin), in the real app over CDP. A Maven project whose Spring Boot
// 9.1.0 jars are in a fake Maven repository (PYIDE_BUILD_HOME): the starter's pom leads to the spring-boot and
// spring-boot-autoconfigure jars and a third-party starter's to its autoconfigure jar, whose metadata (and an enum's
// class file) are what the editor offers. In application.properties: key completion with the type and default
// (accepting a key with values asks for the value), values of a hint (spring.jpa.hibernate.ddl-auto), a Boolean, an
// enum class and log levels under logging.level.*, hover, warnings for unknown keys with the key they probably meant
// (spring.application.port -> server.port, server.prot -> server.port) and Alt+Enter's Replace with, and for a
// deprecated key (none for the application's own keys, keys it declares in its own additional metadata, relaxed names
// or map entries). messages.properties in the same project and an application.properties outside any Spring project
// get nothing. A Gradle module whose Spring Boot version is not in the cache falls back to the bundled metadata, which
// warns only below the prefixes of its complete modules. application.yml: nested key and
// value completion, hover and the unknown-key warning through data-formats. The strings in Korean. Ports 9844-9845.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;

// ---------- the fake Maven repository ----------
// A deflated zip, as jars are.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(8, 10); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
// The class file of `enum <name> { constants }`: only what an enum's constants need.
function enumClass(name, constants) {
  const pool = [];
  const utf8 = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(3); h[0] = 1; h.writeUInt16BE(b.length, 1); pool.push(Buffer.concat([h, b])); return pool.length; };
  const cls = (i) => { const b = Buffer.alloc(3); b[0] = 7; b.writeUInt16BE(i, 1); pool.push(b); return pool.length; };
  const self = cls(utf8(name));
  const sup = cls(utf8('java/lang/Enum'));
  const desc = utf8(`L${name};`);
  const names = constants.map(utf8);
  const u16 = (...v) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x, 2 * i)); return b; };
  return Buffer.concat([Buffer.from('cafebabe00000034', 'hex'), u16(pool.length + 1), ...pool, u16(0x4031, self, sup, 0, names.length),
    ...names.map((n) => u16(0x4019, n, desc, 0)), u16(0, 0)]);
}
const meta = (o) => JSON.stringify(o, null, 2);
const pom = (g, a, v, deps = '', extra = '') => `<?xml version="1.0"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>${g}</groupId>\n  <artifactId>${a}</artifactId>\n  <version>${v}</version>\n${extra}  <dependencies>\n${deps}  </dependencies>\n</project>\n`;
const dep = (g, a, v, more = '') => `    <dependency>\n      <groupId>${g}</groupId>\n      <artifactId>${a}</artifactId>\n${v ? `      <version>${v}</version>\n` : ''}${more}    </dependency>\n`;

const work = mkdtempSync(path.join(tmpdir(), 'pyide-spring-config-'));
const buildHome = path.join(work, 'home');
const repo = path.join(buildHome, '.m2', 'repository');
function put(g, a, v, files) {
  const dir = path.join(repo, ...g.split('.'), a, v);
  mkdirSync(dir, { recursive: true });
  for (const [ext, content] of Object.entries(files)) writeFileSync(path.join(dir, `${a}-${v}.${ext}`), content);
}
const BOOT = 'org.springframework.boot';
put(BOOT, 'spring-boot-starter-web', '9.1.0', {
  pom: pom(BOOT, 'spring-boot-starter-web', '9.1.0', dep(BOOT, 'spring-boot', '9.1.0') + dep(BOOT, 'spring-boot-autoconfigure', '9.1.0', '      <scope>compile</scope>\n')),
  jar: zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' }),
});
put(BOOT, 'spring-boot', '9.1.0', {
  pom: pom(BOOT, 'spring-boot', '9.1.0'),
  jar: zip({
    'META-INF/spring-configuration-metadata.json': meta({
      groups: [{ name: 'spring.main' }, { name: 'logging' }],
      properties: [
        { name: 'spring.main.banner-mode', type: 'com.example.fake.Banner$Mode', description: 'Mode used to display the banner when the application runs.' },
        { name: 'spring.application.name', type: 'java.lang.String', description: 'Application name.' },
        { name: 'spring.main.lazy-initialization', type: 'java.lang.Boolean', description: 'Whether initialization should be performed lazily.', defaultValue: false },
        { name: 'logging.level', type: 'java.util.Map<java.lang.String,java.lang.String>', description: 'Log levels severity mapping.' },
      ],
      hints: [
        { name: 'logging.level.keys', values: [{ value: 'root', description: 'Root logger used to assign the default logging level.' }, { value: 'web', description: 'Web logging group.' }] },
        { name: 'logging.level.values', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'off'].map((value) => ({ value })) },
      ],
    }),
    'com/example/fake/Banner$Mode.class': enumClass('com/example/fake/Banner$Mode', ['OFF', 'CONSOLE', 'LOG']),
  }),
});
put(BOOT, 'spring-boot-autoconfigure', '9.1.0', {
  pom: pom(BOOT, 'spring-boot-autoconfigure', '9.1.0', dep(BOOT, 'spring-boot', '9.1.0')),
  jar: zip({
    'META-INF/spring-configuration-metadata.json': meta({
      groups: [{ name: 'server' }, { name: 'spring.datasource' }, { name: 'spring.jpa.hibernate' }],
      properties: [
        { name: 'server.port', type: 'java.lang.Integer', description: 'Server HTTP port, from the test jar.', defaultValue: 8080 },
        { name: 'management.server.port', type: 'java.lang.Integer', description: 'Management endpoint HTTP port.' },
        { name: 'server.address', type: 'java.net.InetAddress', description: 'Network address to which the server should bind.' },
        { name: 'server.old-port', type: 'java.lang.Integer', description: 'The old port.', deprecation: { level: 'warning', replacement: 'server.port', reason: 'Renamed in 9.0.' } },
        { name: 'spring.datasource.url', type: 'java.lang.String', description: 'JDBC URL of the database.' },
        { name: 'spring.jpa.hibernate.ddl-auto', type: 'java.lang.String', description: 'DDL mode, from the test jar.' },
      ],
    }),
    'META-INF/additional-spring-configuration-metadata.json': meta({
      hints: [{ name: 'spring.jpa.hibernate.ddl-auto', values: [
        { value: 'none', description: 'Disable DDL handling.' }, { value: 'validate', description: 'Validate the schema.' },
        { value: 'update', description: 'Update the schema if necessary.' }, { value: 'create', description: 'Create the schema.' },
        { value: 'create-drop', description: 'Create and then destroy the schema.' }] }],
    }),
  }),
});
// A third-party starter: its version from the project's property, its autoconfigure module's from ${project.version};
// an optional and a test dependency of the starter are not followed.
put('com.acme', 'acme-spring-boot-starter', '1.2.0', {
  pom: pom('com.acme', 'acme-spring-boot-starter', '1.2.0', dep('com.acme', 'acme-autoconfigure', '${project.version}')
    + dep('com.acme', 'acme-optional', '1.2.0', '      <optional>true</optional>\n') + dep('com.acme', 'acme-test', '1.2.0', '      <scope>test</scope>\n')),
  jar: zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' }),
});
const acmeMeta = (name) => zip({ 'META-INF/spring-configuration-metadata.json': meta({ groups: [{ name: 'acme' }], properties: [{ name, type: 'java.lang.String', description: `${name}, from an acme jar.` }] }) });
put('com.acme', 'acme-autoconfigure', '1.2.0', { pom: pom('com.acme', 'acme-autoconfigure', '1.2.0'), jar: acmeMeta('acme.greeting') });
put('com.acme', 'acme-optional', '1.2.0', { pom: pom('com.acme', 'acme-optional', '1.2.0'), jar: acmeMeta('acme.optional-only') });
put('com.acme', 'acme-test', '1.2.0', { pom: pom('com.acme', 'acme-test', '1.2.0'), jar: acmeMeta('acme.test-only') });
const outside = path.join(work, 'outside', 'application.properties');
mkdirSync(path.dirname(outside), { recursive: true });
writeFileSync(outside, 'server.port=8080\n');

// ---------- the editor ----------
const env = { PYIDE_BUILD_HOME: buildHome };
const t = await launch({ fixture: 'spring-config', port: 9844, env });
const { js, until, press, type, check, sleep } = t;

const edFor = (p) => `ide.monaco.editor.getEditors().find(e => e.getModel()?.uri.fsPath.toLowerCase() === ${J(p.toLowerCase())} && e.getDomNode()?.isConnected)`;
let ED = 'ide.editor';
async function open(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(t.project, rel);
  if (path.isAbsolute(rel)) await js(`ide.openFile(${J(abs)})`);
  else await openFile(t, rel);
  await until(`!!${edFor(abs)}`, `editor for ${rel}`);
  ED = edFor(abs);
  await js(`(${ED}.focus(), true)`);
  return abs;
}
const setText = (text, line = 1, col = 1) => js(`(() => { const e = ${ED}; e.trigger('t', 'hideSuggestWidget', {}); e.trigger('t', 'leaveSnippet', {});
  e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); return true; })()`);
const setEnd = (text) => { const lines = text.split('\n'); return setText(text, lines.length, lines.at(-1).length + 1); };
const text = () => js(`${ED}.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const rowsNow = () => js(`[...(${ED}.getDomNode().querySelector('.suggest-widget.visible')?.querySelectorAll('.monaco-list-row') || [])].map(r => ({
  label: r.querySelector('.label-name')?.textContent, text: r.textContent,
  icon: ([...(r.querySelector('.suggest-icon')?.classList || [])].find(c => c.startsWith('codicon-symbol-')) || '').replace('codicon-symbol-', '') }))`);
// The completion list at the end of `start`: [{label, description, detail, icon}].
async function completions(start) {
  await setEnd(start);
  await sleep(100);
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`!!${ED}.getDomNode().querySelector('.suggest-widget.visible .monaco-list-row') || !!${ED}.getDomNode().querySelector('.suggest-widget.visible .message')`, `completion list for ${J(start.slice(-30))}`, 10000).catch(() => {});
  await sleep(400);
  return rowsNow();
}
const hideSuggest = () => js(`(${ED}.trigger('t', 'hideSuggestWidget', {}), true)`);
const labels = (rows, icon) => rows.filter((r) => !icon || r.icon === icon).map((r) => r.label);
const markers = (owner) => js(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: ${J(owner)} }).map(m => ({ line: m.startLineNumber, col: m.startColumn, message: m.message }))`);
async function hoverAt(line, col) {
  await js(`(() => { const e = ${ED}; e.setPosition({ lineNumber: ${line}, column: ${col} }); e.focus(); e.trigger('t', 'editor.action.showHover', {}); return true; })()`);
  await until(`[...document.querySelectorAll('.monaco-hover')].some(h => h.textContent.trim() && h.getClientRects().length)`, 'hover', 8000).catch(() => {});
  await sleep(200);
  const s = await js(`[...document.querySelectorAll('.monaco-hover')].filter(h => h.getClientRects().length).map(h => h.textContent).join(' | ')`);
  await press('Escape');
  return s;
}
// Alt+Enter, then the quick fix whose title is given, with the arrow keys.
async function quickFix(title) {
  const rows = `[...document.querySelectorAll('.action-widget .monaco-list-row')]`;
  await press('Alt+Enter');
  await until(`${rows}.length > 0`, 'quick fix menu', 5000);
  for (let i = 0; i < 10; i++) {
    if (await js(`${rows}.find((r) => r.classList.contains('focused'))?.textContent.includes(${J(title)})`)) {
      await press('Enter');
      await until(`!document.querySelector('.action-widget .monaco-list-row')`, 'quick fix menu closes');
      return;
    }
    await press('ArrowDown');
  }
  throw new Error(`no quick fix "${title}" in ${J(await js(`${rows}.map((r) => r.textContent)`))}`);
}
const metadata = (p) => js(`ide.springConfig.metadata(${J(p)}).then(m => m && { source: m.source, boot: m.boot, names: m.properties.map(p => p.name) })`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.springConfig`), 'spring-config plugin loaded');

  // ---------- the project's own metadata ----------
  const props = await open('src/main/resources/application.properties');
  const m = await metadata(props);
  check(m?.source === 'project' && m.boot === '9.1.0', `metadata from the project's Spring Boot 9.1.0 jars (${J(m && { source: m.source, boot: m.boot })})`);
  check(m?.names.includes('acme.greeting') && m.names.includes('spring.main.banner-mode'), 'the third-party starter\'s autoconfigure jar and spring-boot\'s jar are read');
  check(m && !m.names.includes('acme.optional-only') && !m.names.includes('acme.test-only'), 'optional and test dependencies of a dependency are not followed');
  check(m && !m.names.includes('spring.thymeleaf.cache'), 'the bundled metadata stays out when the project\'s own is there');

  // Keys.
  let rows = await completions('server.po');
  const port = rows.find((r) => r.label === 'server.port');
  check(port?.icon === 'property' && port.text.endsWith('Integer'), `server.port is offered with its type on the right (${J(port)})`);
  await js(`(${ED}.trigger('t', 'toggleSuggestionDetails', {}), true)`);
  await until(`/from the test jar/.test(document.querySelector('.suggest-details')?.textContent || '')`, 'suggestion details', 5000).catch(() => {});
  const details = await js(`document.querySelector('.suggest-details')?.textContent || ''`);
  check(/Integer = 8080/.test(details) && /Server HTTP port, from the test jar\./.test(details), `its details show the type, default and description (${J(details.slice(0, 160))})`);
  await press('Enter');
  await until(`${ED}.getModel().getValue() === 'server.port='`, 'server.port accepted', 5000).catch(() => {});
  check(await text() === 'server.port=', `accepting the key writes "server.port=" (${J(await text())})`);
  await hideSuggest();
  rows = await completions('acme.gr');
  check(labels(rows, 'property').includes('acme.greeting'), `a third-party key completes (${J(labels(rows, 'property'))})`);
  await hideSuggest();
  rows = await completions('logging.level.r');
  check(labels(rows, 'property').includes('logging.level.root'), `a log level key hint completes (${J(labels(rows, 'property'))})`);
  await hideSuggest();
  // A key with values asks for the value once accepted.
  await setEnd('spring.jpa.hibernate.ddl');
  await js(`(${ED}.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`[...${ED}.getDomNode().querySelectorAll('.suggest-widget.visible .monaco-list-row.focused .label-name')].some(n => n.textContent === 'spring.jpa.hibernate.ddl-auto')`, 'ddl-auto focused', 8000).catch(() => {});
  await press('Enter');
  await until(`[...${ED}.getDomNode().querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].some(n => n.textContent === 'create-drop')`, 'ddl-auto values', 8000).catch(() => {});
  rows = await rowsNow();
  check(await text() === 'spring.jpa.hibernate.ddl-auto=' && J(labels(rows, 'enum-member')) === J(['none', 'validate', 'update', 'create', 'create-drop']),
    `accepting spring.jpa.hibernate.ddl-auto lists its values (${J(await text())}, ${J(labels(rows))})`);
  for (const ch of 'up') await type(ch);
  await until(`${ED}.getDomNode().querySelector('.suggest-widget.visible .monaco-list-row.focused .label-name')?.textContent === 'update'`, 'update focused', 5000).catch(() => {});
  await press('Enter');
  await until(`${ED}.getModel().getValue() === 'spring.jpa.hibernate.ddl-auto=update'`, 'update accepted', 5000).catch(() => {});
  check(await text() === 'spring.jpa.hibernate.ddl-auto=update', `a value is inserted after "=" (${J(await text())})`);

  // Values.
  rows = await completions('spring.main.lazy-initialization=');
  check(J(labels(rows, 'enum-member')) === J(['true', 'false']), `a Boolean offers true and false (${J(labels(rows))})`);
  await hideSuggest();
  rows = await completions('spring.main.banner-mode = ');
  check(J(labels(rows, 'enum-member')) === J(['off', 'console', 'log']), `an enum's values come from its class file (${J(labels(rows))})`);
  await hideSuggest();
  rows = await completions('logging.level.com.example.demo=');
  check(J(labels(rows, 'enum-member')) === J(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'off']), `logging.level.* offers the log levels (${J(labels(rows))})`);
  await hideSuggest();
  rows = await completions('server.port=80');
  check(!rows.some((r) => r.icon === 'enum-member'), `a property without known values offers none (${J(labels(rows))})`);
  await hideSuggest();

  // Hover.
  await setText('server.port=9090\nlogging.level.root=info\n');
  let hover = await hoverAt(1, 4);
  check(/server\.port/.test(hover) && /Integer/.test(hover) && /Server HTTP port, from the test jar\./.test(hover) && /Default: 8080/.test(hover), `hovering a key shows its description (${J(hover)})`);
  hover = await hoverAt(2, 16);
  check(/Log levels severity mapping/.test(hover) && /Root logger used/.test(hover), `hovering a map key shows the map and the key's hint (${J(hover)})`);

  // Warnings.
  // Spring Boot ignores an unknown key without a word: spring.application.port=80 still runs on 8080.
  await setText('server.prot=1\nserver.old-port=2\napp.title=Demo\nlogging.level.org.example=debug\nspring.main.lazyInitialization=true\nspring.datasource.URL=jdbc:h2:mem:x\n# server.nope=1\nacme.greeting=hi\nacme.nope=1\nspring.application.port=80\ndemo.custom.greeting=Hi\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'spring-config' }).length >= 4`, 'warnings', 8000).catch(() => {});
  const warns = await markers('spring-config');
  check(J(warns.map((w) => w.line)) === J([1, 2, 9, 10]), `unknown and deprecated keys are warned about; the application's own, map entries, relaxed names and declared custom keys are not (${J(warns)})`);
  check(warns[0]?.message === 'Unknown Spring Boot property: server.prot Did you mean server.port?', `a typo suggests the key it misspells (${J(warns[0]?.message)})`);
  check(/deprecated/.test(warns[1]?.message) && /Use server\.port instead/.test(warns[1].message) && /Renamed in 9\.0/.test(warns[1].message), `a deprecated key names its replacement (${J(warns[1]?.message)})`);
  check(warns[2]?.message === 'Unknown Spring Boot property: acme.nope', `a key with nothing close gets no suggestion (${J(warns[2]?.message)})`);
  check(warns[3]?.message === 'Unknown Spring Boot property: spring.application.port Did you mean server.port?', `spring.application.port suggests server.port by its last segment (${J(warns[3]?.message)})`);
  hover = await hoverAt(10, 5);
  check(/Unknown Spring Boot property: spring\.application\.port/.test(hover), `hovering the squiggle shows the warning (${J(hover)})`);
  await js(`(() => { const e = ${ED}; e.setPosition({ lineNumber: 10, column: 5 }); e.focus(); return true; })()`);
  await quickFix('Replace with server.port');
  await until(`${ED}.getModel().getLineContent(10) === 'server.port=80'`, 'key replaced', 5000).catch(() => {});
  const fixed = await js(`${ED}.getModel().getLineContent(10)`);
  check(fixed === 'server.port=80', `Alt+Enter › Replace with server.port fixes the key (${J(fixed)})`);
  await until(`!ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'spring-config' }).some(m => m.startLineNumber === 10)`, 'warning gone', 5000).catch(() => {});
  check(!(await markers('spring-config')).some((w) => w.line === 10), 'and its warning goes');
  rows = await completions('demo.custom.gr');
  check(labels(rows, 'property').includes('demo.custom.greeting'), `a key the project declares in its own additional metadata completes (${J(labels(rows, 'property'))})`);
  await hideSuggest();

  // ---------- no Spring Boot completion elsewhere ----------
  await open('src/main/resources/messages.properties');
  rows = await completions('server.po');
  check(!labels(rows).includes('server.port'), `messages.properties gets no Spring Boot keys (${J(labels(rows))})`);
  await hideSuggest();
  await open(outside);
  check(await metadata(outside) === null, 'an application.properties outside a Spring Boot project has no metadata');
  rows = await completions('server.po');
  check(!labels(rows).includes('server.port'), `and gets no Spring Boot keys (${J(labels(rows))})`);
  await hideSuggest();
  await setText('server.prot=1\n');
  await sleep(800);
  check((await markers('spring-config')).length === 0, 'and no warnings');

  // ---------- the bundled metadata ----------
  const gradleProps = await open('gradle-app/src/main/resources/application.properties');
  const g = await metadata(gradleProps);
  check(g?.source === 'bundled' && g.names.includes('spring.datasource.url') && g.names.includes('spring.thymeleaf.cache'),
    `a Gradle module whose Spring Boot jars are not in the cache uses the bundled metadata (${J(g && { source: g.source, boot: g.boot, count: g.names.length })})`);
  rows = await completions('spring.datasource.u');
  check(labels(rows, 'property').includes('spring.datasource.url') && labels(rows, 'property').includes('spring.datasource.username'), `bundled keys complete (${J(labels(rows, 'property'))})`);
  await hideSuggest();
  rows = await completions('spring.jpa.hibernate.ddl-auto=');
  check(J(labels(rows, 'enum-member')) === J(['none', 'validate', 'update', 'create', 'create-drop']), `bundled values complete (${J(labels(rows))})`);
  await hideSuggest();
  rows = await completions('spring.main.banner-mode=');
  check(J(labels(rows, 'enum-member')) === J(['off', 'console', 'log']), `bundled enum values complete (${J(labels(rows))})`);
  await hideSuggest();
  await setText('server.prot=1\nspring.flyway.schemas=app\nspring.cloud.foo=1\nspring.application.port=80\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'spring-config' }).length >= 2`, 'bundled warnings', 8000).catch(() => {});
  await sleep(300);
  const bw = await markers('spring-config');
  check(J(bw.map((w) => w.line)) === J([1, 4]) && bw.every((w) => /Did you mean server\.port\? \(checked against the Spring Boot 4\.1\.2 metadata bundled with the app\)$/.test(w.message)),
    `the bundled metadata warns only below the prefixes of its complete modules, and says so (${J(bw)})`);

  // ---------- application.yml ----------
  await open('src/main/resources/application.yml');
  rows = await completions('server:\n  po');
  check(labels(rows, 'property').includes('port'), `YAML: a nested key completes (${J(labels(rows, 'property'))})`);
  await hideSuggest();
  rows = await completions('spring:\n  jpa:\n    hibernate:\n      ddl-auto: ');
  check(['none', 'validate', 'update', 'create', 'create-drop'].every((v) => labels(rows).includes(v)), `YAML: a value completes (${J(labels(rows))})`);
  await hideSuggest();
  rows = await completions('logging:\n  level:\n    com.example: ');
  check(['trace', 'debug', 'off'].every((v) => labels(rows).includes(v)), `YAML: log levels complete under logging.level (${J(labels(rows))})`);
  await hideSuggest();
  await setText('server:\n  port: 9090\n');
  hover = await hoverAt(2, 4);
  check(/Server HTTP port, from the test jar\./.test(hover) && /Integer/.test(hover) && /8080/.test(hover), `YAML: hovering a key shows its description (${J(hover)})`);
  await setText('server:\n  prot: 1\n  servletPath: /x\napp:\n  title: Demo\nlogging:\n  level:\n    org.example: debug\nspring:\n  application:\n    port: 80\ndemo:\n  custom:\n    greeting: Hi\n');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ${ED}.getModel().uri, owner: 'data-formats' }).length >= 1`, 'YAML warnings', 8000).catch(() => {});
  await sleep(500);
  const ywarns = await markers('data-formats');
  check(J(ywarns.map((w) => [w.line, w.message])) === J([[2, 'Unknown key "prot"'], [11, 'Unknown key "port"']]), `YAML: only unknown Spring Boot keys are warned about (${J(ywarns)})`);
} catch (err) {
  check(false, `unexpected error: ${err.stack || err.message}`);
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'spring-config', port: 9845, name: 'spring-config-ko', lang: 'ko-KR', env });
try {
  const p = path.join(k.project, 'src', 'main', 'resources', 'application.properties');
  await openFile(k, 'src/main/resources/application.properties');
  const KED = edFor(p);
  await k.until(`!!${KED}`, 'editor (ko)');
  await k.js(`ide.springConfig.metadata(${J(p)})`);
  await k.js(`(${KED}.getModel().setValue('server.port=1\\nserver.prot=1\\nserver.old-port=2\\n'), true)`);
  await k.until(`ide.monaco.editor.getModelMarkers({ resource: ${KED}.getModel().uri, owner: 'spring-config' }).length >= 2`, 'markers (ko)', 8000).catch(() => {});
  const kms = await k.js(`ide.monaco.editor.getModelMarkers({ resource: ${KED}.getModel().uri, owner: 'spring-config' }).map(m => m.message)`);
  k.check(kms.length === 2 && kms.includes('알 수 없는 Spring Boot 속성입니다: server.prot 혹시 server.port 속성인가요?') && kms.every((m) => /[가-힣]/.test(m)), `Korean warnings (${J(kms)})`);
  await k.js(`(() => { const e = ${KED}; e.setPosition({ lineNumber: 1, column: 4 }); e.focus(); e.trigger('t', 'editor.action.showHover', {}); return true; })()`);
  await k.until(`[...document.querySelectorAll('.monaco-hover')].some(h => /기본값/.test(h.textContent))`, 'Korean hover', 8000).then(() => true, () => false)
    .then((ok) => k.check(ok, 'Korean hover text'));
  const plugin = await k.js(`tr('Spring Boot Configuration Files')`);
  k.check(/[가-힣]/.test(plugin), `Korean plugin name (${J(plugin)})`);
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `no untranslated strings (${J(missing)})`);
} catch (err) {
  k.check(false, `unexpected error: ${err.stack || err.message}`);
}
k.close();
rmSync(work, { recursive: true, force: true });

const all = [...t.results, ...k.results];
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
