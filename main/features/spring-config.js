// Spring Boot configuration metadata for application.properties and application.yml, as IntelliJ IDEA and VS Code's
// Spring Boot Tools read it. The module's build file (pom.xml with its parents, build.gradle or build.gradle.kts) names
// the Spring Boot version and the dependencies; their poms in the Maven or Gradle cache give the rest of the dependency
// tree, and the jars' META-INF/spring-configuration-metadata.json (and additional-spring-configuration-metadata.json)
// the properties. Enum types' values come from their class files. The module's own @ConfigurationProperties come from
// its compiled metadata (target/classes, build/classes) and src/main/resources/META-INF. When no Spring Boot jar of the
// module is in the cache (never built, or an untrusted project, whose build files are not followed), the metadata
// bundled with the app (main/spring/boot-metadata.json, made by tools/spring-boot-metadata.mjs) stands in.
const fs = require('fs');
const os = require('os');
const path = require('path');
const trust = require('../trust');
const { readZipEntries } = require('../zip');

const META_FILES = ['META-INF/spring-configuration-metadata.json', 'META-INF/additional-spring-configuration-metadata.json'];
const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
const COORD = /^[\w.-]+$/;
const MAX_ARTIFACTS = 600;
const BUNDLED = path.join(__dirname, '..', 'spring', 'boot-metadata.json');

const home = () => process.env.PYIDE_BUILD_HOME || os.homedir();
const unc = (p) => /^[\\/]{2}/.test(p);

async function stat(p) {
  try { return await fs.promises.stat(p); } catch { return null; }
}
async function readText(p) {
  try { return (await fs.promises.readFile(p, 'utf8')).replace(/^﻿/, ''); } catch { return null; }
}

// ---------- the caches ----------
async function repos() {
  const h = home();
  let maven = path.join(h, '.m2', 'repository');
  const settings = await readText(path.join(h, '.m2', 'settings.xml'));
  const local = settings && /<localRepository>\s*([^<]+?)\s*<\/localRepository>/.exec(stripComments(settings))?.[1]
    .replace(/\$\{user\.home\}/g, () => h);
  if (local && path.isAbsolute(local) && !unc(local)) maven = local;
  const gradleHome = (!process.env.PYIDE_BUILD_HOME && process.env.GRADLE_USER_HOME) || path.join(h, '.gradle');
  return { maven, gradle: path.join(gradleHome, 'caches', 'modules-2', 'files-2.1') };
}

// group:artifact:version's .pom or .jar in the Maven repository or Gradle's cache, or null.
async function artifact(r, g, a, v, ext) {
  if (![g, a, v].every((s) => typeof s === 'string' && COORD.test(s) && !s.split('.').includes(''))) return null;
  const m = path.join(r.maven, ...g.split('.'), a, v, `${a}-${v}.${ext}`);
  if ((await stat(m))?.isFile()) return m;
  const dir = path.join(r.gradle, g, a, v);
  let subs = [];
  try { subs = await fs.promises.readdir(dir); } catch { return null; }
  for (const s of subs) {
    const f = path.join(dir, s, `${a}-${v}.${ext}`);
    if ((await stat(f))?.isFile()) return f;
  }
  return null;
}

// ---------- Maven ----------
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const tagOf = (t, name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(t)?.[1];
const blockOf = (t, name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(t)?.[1];
const without = (t, ...names) => names.reduce((s, n) => s.replace(new RegExp(`<${n}(?:\\s[^>]*)?>[\\s\\S]*?</${n}>`, 'g'), ''), t);
const depsIn = (t = '') => [...t.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map(([, d]) => ({
  g: tagOf(d, 'groupId'), a: tagOf(d, 'artifactId'), v: tagOf(d, 'version'), scope: tagOf(d, 'scope') || 'compile',
  type: tagOf(d, 'type'), optional: tagOf(d, 'optional') === 'true',
})).filter((d) => d.g && d.a);

function parsePom(text) {
  const t = stripComments(text);
  const parent = blockOf(t, 'parent');
  const body = without(t, 'dependencyManagement', 'build', 'profiles', 'reporting', 'parent');
  const head = without(body, 'dependencies');
  const props = {};
  for (const [, k, v] of (blockOf(head, 'properties') || '').matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props[k] = v;
  return {
    parent: parent && { g: tagOf(parent, 'groupId'), a: tagOf(parent, 'artifactId'), v: tagOf(parent, 'version'),
      rel: /<relativePath\s*\/>/.test(parent) ? '' : tagOf(parent, 'relativePath') },
    g: tagOf(head, 'groupId'), a: tagOf(head, 'artifactId'), v: tagOf(head, 'version'), props,
    deps: depsIn(blockOf(body, 'dependencies')),
    managed: depsIn(blockOf(t, 'dependencyManagement')),
  };
}

const pomCache = new Map(); // file -> {mtime, pom}
async function loadPom(file) {
  const st = await stat(file);
  if (!st?.isFile()) return null;
  const c = pomCache.get(file);
  if (c?.mtime === st.mtimeMs) return c.pom;
  const text = await readText(file);
  const pom = text ? parsePom(text) : null;
  pomCache.set(file, { mtime: st.mtimeMs, pom });
  return pom;
}

const isBootBom = (g, a) => g === 'org.springframework.boot' && /^spring-boot-(?:starter-parent|dependencies)$/.test(a);
// The pom with its parents merged in, as Maven inherits them: properties, dependencies and managed versions, and the
// Spring Boot version a parent or an imported BOM sets. local: a project's pom, whose parent may be ../pom.xml.
async function effectivePom(r, file, local, depth = 0) {
  const pom = await loadPom(file);
  if (!pom) return null;
  let parent = null;
  const p = pom.parent;
  if (p && depth < 10) {
    if (local && p.rel !== '') {
      const rel = path.resolve(path.dirname(file), p.rel || '..');
      const lf = /\.xml$/i.test(rel) ? rel : path.join(rel, 'pom.xml');
      if ((await loadPom(lf))?.a === p.a) parent = await effectivePom(r, lf, true, depth + 1);
    }
    if (!parent) {
      const rf = await artifact(r, p.g, p.a, p.v, 'pom');
      if (rf) parent = await effectivePom(r, rf, false, depth + 1);
    }
  }
  const version = pom.v || p?.v;
  const props = { ...parent?.props, ...pom.props, 'project.version': version, version, 'project.parent.version': p?.v, 'project.groupId': pom.g || p?.g };
  const sub = (s) => {
    for (let i = 0; i < 5 && s?.includes('${'); i++) s = s.replace(/\$\{([^}]+)\}/g, (m, k) => props[k] ?? m);
    return s;
  };
  let boot = parent?.boot || null;
  if (p && isBootBom(p.g, p.a)) boot = sub(p.v);
  const managed = new Map(parent?.managed);
  for (const d of pom.managed) {
    const [g, a, v] = [sub(d.g), sub(d.a), sub(d.v)];
    if (isBootBom(g, a) && v) boot = v;
    if (v && !managed.has(`${g}:${a}`)) managed.set(`${g}:${a}`, v);
  }
  const deps = [...(parent?.deps || []), ...pom.deps.map((d) => ({ ...d, g: sub(d.g), a: sub(d.a), v: sub(d.v) }))];
  return { props, boot, managed, deps };
}

// ---------- Gradle ----------
const GRADLE_DEP = /^[ \t]*(\w+)[ \t]*\(?[ \t]*(?:(?:platform|enforcedPlatform)[ \t]*\(?[ \t]*)?["']([\w.-]+):([\w.-]+)(?::([\w.${}-]+))?(?::[\w-]+)?(?:@\w+)?["']/gm;
const GRADLE_CATALOG_DEP = /^[ \t]*(\w+)[ \t]*\(?[ \t]*(?:(?:platform|enforcedPlatform)[ \t]*\(?[ \t]*)?libs\.([\w.]+)/gm;
const BOOT_PLUGIN = /id[ \t]*\(?[ \t]*["']org\.springframework\.boot["'][ \t]*\)?[ \t]*version[ \t]*\(?[ \t]*["']([^"']+)["']|org\.springframework\.boot:spring-boot-(?:gradle-plugin|dependencies):([\w.${}-]+)/;
const alias = (s) => s.replace(/[-_.]/g, '.').toLowerCase();

// [versions] and [libraries] of gradle/libs.versions.toml, and the Spring Boot plugin's version there.
function parseCatalog(text) {
  const versions = {};
  const libs = new Map();
  let boot = null;
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const str = /^"([^"]*)"$/.exec(value)?.[1];
    const field = (name) => new RegExp(`${name.replace('.', '\\.')}\\s*=\\s*"([^"]*)"`).exec(value)?.[1];
    if (section === 'versions' && str !== undefined) versions[key] = str;
    else if (section === 'libraries') {
      const coords = str || field('module') || (field('group') && `${field('group')}:${field('name')}`);
      const [g, a, v] = (coords || '').split(':');
      const ver = v || field('version') || versions[field('version.ref')];
      if (g && a) libs.set(alias(key), { g, a, v: ver, ref: field('version.ref') });
    } else if (section === 'plugins' && (str?.startsWith('org.springframework.boot:') || field('id') === 'org.springframework.boot')) {
      boot = str ? str.split(':')[1] : field('version') || field('version.ref');
      if (boot && !str && !field('version')) boot = { ref: boot };
    }
  }
  for (const l of libs.values()) if (!l.v && l.ref) l.v = versions[l.ref];
  if (boot?.ref) boot = versions[boot.ref] || null;
  return { libs, boot };
}

async function gradleModule(dir, buildFile, includeTest) {
  const text = stripGradleComments(await readText(buildFile) || '');
  // The plugin version can be in this file, a parent project's build or settings file, gradle.properties, or the catalog.
  const parents = [];
  for (let d = dir, i = 0; i < 4; i++, d = path.dirname(d)) {
    parents.push(d);
    if (path.dirname(d) === d) break;
  }
  const gprops = {};
  let catalog = null;
  const texts = [text];
  for (const d of parents) {
    for (const f of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
      const p = path.join(d, f);
      if (p !== buildFile) { const t = await readText(p); if (t) texts.push(stripGradleComments(t)); }
    }
    const props = await readText(path.join(d, 'gradle.properties'));
    for (const m of (props || '').matchAll(/^[ \t]*([\w.-]+)[ \t]*[=:][ \t]*(.*?)[ \t]*$/gm)) gprops[m[1]] ??= m[2];
    if (!catalog) {
      const toml = await readText(path.join(d, 'gradle', 'libs.versions.toml'));
      if (toml) catalog = parseCatalog(toml);
    }
  }
  const sub = (s) => s?.replace(/\$\{?(\w+)\}?/g, (m, k) => gprops[k] ?? m);
  let boot = null;
  for (const t of texts) {
    const m = BOOT_PLUGIN.exec(t);
    if (m) { boot = sub(m[1] || m[2]); break; }
  }
  boot ||= catalog?.boot || null;
  const spring = boot || texts.some((t) => t.includes('org.springframework.boot'));
  const wanted = (conf) => !/^(annotationProcessor|kapt|ksp|testAnnotationProcessor)$/.test(conf) && (includeTest || !/^test/i.test(conf));
  const deps = [];
  for (const m of text.matchAll(GRADLE_DEP)) {
    if (!wanted(m[1])) continue;
    const v = sub(m[4]);
    if (m[2] === 'org.springframework.boot' && m[3] === 'spring-boot-dependencies' && v) boot ||= v;
    deps.push({ g: m[2], a: m[3], v, scope: 'compile' });
  }
  for (const m of text.matchAll(GRADLE_CATALOG_DEP)) {
    const lib = wanted(m[1]) && catalog?.libs.get(alias(m[2]));
    if (lib) deps.push({ g: lib.g, a: lib.a, v: lib.v, scope: 'compile' });
  }
  return spring ? { boot, deps, managed: new Map() } : null;
}
const stripGradleComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');

// ---------- the dependency tree ----------
// Nearest wins, as in Maven: the first version met of each group:artifact.
async function dependencyJars(r, mod, includeTest) {
  const seen = new Set();
  const queue = [];
  const jars = [];
  const push = (d, managed, root) => {
    if (!d.g || !d.a || d.optional || d.type === 'pom' && d.scope !== 'import') return;
    const scopes = root ? ['compile', 'runtime', 'provided', ...(includeTest ? ['test'] : [])] : ['compile', 'runtime'];
    if (!scopes.includes(d.scope)) return;
    const key = `${d.g}:${d.a}`;
    if (seen.has(key) || seen.size >= MAX_ARTIFACTS) return;
    let v = d.v && !d.v.includes('$') ? d.v : managed?.get(key) || mod.managed.get(key) || (d.g.startsWith('org.springframework.boot') ? mod.boot : null);
    if (!v || /[[\](),]/.test(v)) return;
    seen.add(key);
    queue.push({ g: d.g, a: d.a, v });
  };
  for (const d of mod.deps) push(d, null, true);
  while (queue.length) {
    await Promise.all(queue.splice(0, 16).map(async (d) => {
      const [pomFile, jar] = await Promise.all([artifact(r, d.g, d.a, d.v, 'pom'), artifact(r, d.g, d.a, d.v, 'jar')]);
      if (jar) jars.push({ file: jar, boot: d.g === 'org.springframework.boot' });
      const pom = pomFile && await effectivePom(r, pomFile, false);
      for (const t of pom?.deps || []) push(t, pom.managed, false);
    }));
  }
  return jars.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------- metadata ----------
const jarCache = new Map(); // file -> {key, docs, classes: Map(class file -> values|null)}
function parseDocs(buffers) {
  const docs = [];
  for (const b of buffers) {
    try {
      const j = JSON.parse(b.toString('utf8').replace(/^﻿/, ''));
      if (j && typeof j === 'object') docs.push(j);
    } catch {}
  }
  return docs;
}
async function jarEntry(file) {
  const st = await stat(file);
  if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  let c = jarCache.get(file);
  if (c?.key !== key) {
    let found = new Map();
    try { found = await readZipEntries(file, (n) => META_FILES.includes(n)); } catch {}
    c = { key, docs: parseDocs(META_FILES.map((n) => found.get(n)).filter(Boolean)), classes: new Map() };
    jarCache.set(file, c);
  }
  return c;
}

// The constants of an enum class file, or null when it is no enum.
function enumConstants(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0xcafebabe) return null;
    const count = buf.readUInt16BE(8);
    const utf8 = [];
    let p = 10;
    for (let i = 1; i < count; i++) {
      const tag = buf[p++];
      if (tag === 1) { const len = buf.readUInt16BE(p); utf8[i] = buf.toString('utf8', p + 2, p + 2 + len); p += 2 + len; }
      else if (tag === 5 || tag === 6) { p += 8; i++; }
      else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) p += 4;
      else if ([7, 8, 16, 19, 20].includes(tag)) p += 2;
      else if (tag === 15) p += 3;
      else return null;
    }
    if (!(buf.readUInt16BE(p) & 0x4000)) return null; // ACC_ENUM
    p += 6;
    p += 2 + 2 * buf.readUInt16BE(p);
    const fields = buf.readUInt16BE(p);
    p += 2;
    const out = [];
    for (let i = 0; i < fields; i++) {
      const flags = buf.readUInt16BE(p);
      const name = utf8[buf.readUInt16BE(p + 2)];
      const attrs = buf.readUInt16BE(p + 6);
      p += 8;
      for (let a = 0; a < attrs; a++) p += 6 + buf.readUInt32BE(p + 2);
      if (flags & 0x4000 && name) out.push(name);
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

const SIMPLE = /^java\.|^javax?\.|^kotlin\./;
// The type whose values a property takes: a Map's value type, a collection's or array's element type.
function elementType(type) {
  if (!type) return null;
  let t = type.replace(/\s+/g, '');
  const map = /^[\w.$]*Map<[^,<>]+,(.+)>$/.exec(t);
  if (map) t = map[1];
  const coll = /^[\w.$]*(?:List|Set|Collection)<(.+)>$/.exec(t);
  if (coll) t = coll[1];
  t = t.replace(/\[\]$/, '');
  return /^[\w.$]+$/.test(t) ? t : null;
}
const enumValue = (c) => c.toLowerCase().replace(/_/g, '-');
const BOOLEAN = new Set(['java.lang.Boolean', 'boolean']);
const isMap = (type) => /^[\w.$]*Map</.test(type || '');
const fmtDefault = (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const hintValues = (h) => (Array.isArray(h?.values) ? h.values.filter((x) => x && x.value !== undefined && x.value !== null && typeof x.value !== 'object')
  .map((x) => ({ value: String(x.value), ...(typeof x.description === 'string' && { description: x.description }) })) : []);

// Spring Boot's metadata files merged (the first of each name wins) into what the editor needs:
// {properties: [{name, type, description, default, deprecation, values, keys, map, partial}], groups: [name]}.
function merge(docs, enums) {
  const props = new Map();
  const hints = new Map();
  const groups = new Set();
  for (const d of docs) {
    for (const g of Array.isArray(d.groups) ? d.groups : []) if (typeof g?.name === 'string') groups.add(g.name);
    for (const p of Array.isArray(d.properties) ? d.properties : []) if (typeof p?.name === 'string' && p.name && !props.has(p.name)) props.set(p.name, p);
    for (const h of Array.isArray(d.hints) ? d.hints : []) if (typeof h?.name === 'string' && !hints.has(h.name)) hints.set(h.name, h);
  }
  const properties = [];
  for (const p of props.values()) {
    const type = typeof p.type === 'string' ? p.type : undefined;
    const map = isMap(type);
    let values = hintValues(hints.get(map ? `${p.name}.values` : p.name) || hints.get(`${p.name}.values`));
    const el = elementType(type);
    if (!values.length && BOOLEAN.has(el)) values = [{ value: 'true' }, { value: 'false' }];
    if (!values.length && enums.get(el)) values = enums.get(el).map((c) => ({ value: enumValue(c) }));
    const keys = map ? hintValues(hints.get(`${p.name}.keys`)) : [];
    const dep = p.deprecation || (p.deprecated ? {} : null);
    properties.push({
      name: p.name,
      ...(type && { type }),
      ...(typeof p.description === 'string' && { description: p.description }),
      ...(fmtDefault(p.defaultValue) !== undefined && { default: fmtDefault(p.defaultValue) }),
      ...(dep && { deprecation: { level: dep.level === 'error' ? 'error' : 'warning', ...(typeof dep.replacement === 'string' && { replacement: dep.replacement }), ...(typeof dep.reason === 'string' && { reason: dep.reason }) } }),
      ...(values.length && { values }),
      ...(keys.length && { keys }),
      ...(map && { map: true }),
      ...(p.partial === true && { partial: true }),
    });
  }
  return { properties: properties.sort((a, b) => a.name.localeCompare(b.name)), groups: [...groups].sort() };
}

// Enum types the metadata names and no hint explains, looked up in the jars and the module's class folders.
async function resolveEnums(docs, jars, classDirs) {
  const wanted = new Set();
  for (const d of docs) {
    for (const p of Array.isArray(d.properties) ? d.properties : []) {
      const t = elementType(p?.type);
      if (t && !SIMPLE.test(t) && t.includes('.')) wanted.add(t);
    }
  }
  const enums = new Map();
  if (!wanted.size) return enums;
  const file = (t) => `${t.replace(/\./g, '/')}.class`;
  for (const dir of classDirs) {
    for (const t of wanted) {
      try { const v = enumConstants(await fs.promises.readFile(path.join(dir, ...file(t).split('/')))); if (v) enums.set(t, v); } catch {}
    }
  }
  for (const j of jars) {
    const c = await jarEntry(j.file);
    if (!c) continue;
    const missing = [...wanted].filter((t) => !enums.has(t) && !c.classes.has(file(t)));
    if (missing.length) {
      const names = new Set(missing.map(file));
      let found = new Map();
      try { found = await readZipEntries(j.file, (n) => names.has(n), { maxSize: 1024 * 1024 }); } catch {}
      for (const n of names) c.classes.set(n, found.has(n) ? enumConstants(found.get(n)) : null);
    }
    for (const t of wanted) if (!enums.has(t) && c.classes.get(file(t))) enums.set(t, c.classes.get(file(t)));
  }
  return enums;
}

let bundled = null;
async function bundledDoc() {
  if (!bundled) {
    const text = await readText(BUNDLED);
    try { bundled = text ? JSON.parse(text) : {}; } catch { bundled = {}; }
  }
  return bundled;
}

// The folder of the build file nearest to `dir`, or null.
async function findModule(dir) {
  for (let d = dir, i = 0; i < 12; i++) {
    for (const f of BUILD_FILES) {
      const p = path.join(d, f);
      if ((await stat(p))?.isFile()) return { dir: d, buildFile: p, kind: f === 'pom.xml' ? 'maven' : 'gradle' };
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// file: an application*.properties / .yml -> null when it is in no Spring Boot module, else
// {source: 'project' | 'bundled', boot: the module's Spring Boot version, bundled: the bundled metadata's version (when
// it is used), module, buildFile, properties, groups}.
async function metadataFor(file) {
  const mod = await findModule(path.dirname(file));
  if (!mod) return null;
  const includeTest = /[\\/]src[\\/]test[\\/]/i.test(path.relative(mod.dir, file));
  const trusted = trust.isTrusted(mod.dir);
  const r = await repos();
  let info = null;
  if (!trusted) {
    const text = await readText(mod.buildFile) || '';
    info = /org\.springframework\.boot|spring-boot/.test(text) ? { boot: null, deps: [] } : null;
  } else if (mod.kind === 'maven') {
    const pom = await effectivePom(r, mod.buildFile, true);
    if (pom && (pom.boot || pom.deps.some((d) => d.g?.startsWith('org.springframework.boot')))) info = pom;
  } else {
    info = await gradleModule(mod.dir, mod.buildFile, includeTest);
  }
  if (!info) return null;
  const jars = trusted ? await dependencyJars(r, info, includeTest) : [];
  const docs = [];
  // The module's own @ConfigurationProperties first: they are what the application binds.
  const classDirs = trusted ? [['target', 'classes'], ['build', 'classes', 'java', 'main'], ['build', 'classes', 'kotlin', 'main'], ['build', 'resources', 'main']]
    .map((p) => path.join(mod.dir, ...p)) : [];
  const own = trusted ? [...classDirs.flatMap((d) => META_FILES.map((m) => path.join(d, ...m.split('/')))),
    path.join(mod.dir, 'src', 'main', 'resources', 'META-INF', 'additional-spring-configuration-metadata.json')] : [];
  for (const f of own) {
    const t = await readText(f);
    if (t) docs.push(...parseDocs([Buffer.from(t)]));
  }
  let fromBoot = false;
  for (const j of jars) {
    const c = await jarEntry(j.file);
    if (!c?.docs.length) continue;
    docs.push(...c.docs);
    if (j.boot) fromBoot = true;
  }
  if (!fromBoot) docs.push(await bundledDoc());
  const enums = await resolveEnums(docs, jars, classDirs);
  return { source: fromBoot ? 'project' : 'bundled', boot: info.boot || null, ...(!fromBoot && { bundled: (await bundledDoc()).version || null }),
    module: mod.dir, buildFile: mod.buildFile, ...merge(docs, enums) };
}

module.exports = {
  register({ ipcMain }) {
    ipcMain.handle('spring:configMetadata', async (_e, file) => {
      if (typeof file !== 'string' || !path.isAbsolute(file) || unc(file)) return null;
      return metadataFor(path.resolve(file));
    });
  },
  // tools/spring-boot-metadata.mjs builds the bundled file with these.
  readZipEntries, enumConstants, elementType, META_FILES,
};
