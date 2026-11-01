// Builds NanoBridge.jar: compiles src/ for Java 17 against the oldest Paper API it supports, packs it with plugin.yml, runs
// the tests in test/ against that API and the newest one, compiles src/ against the newest one too, and writes the jar to
// main/minecraft/players/NanoBridge.jar, so that installing the plugin needs no Gradle. The APIs come from this PC's Gradle
// cache, or else from repo.papermc.io into a temporary folder that goes away afterwards. Nothing in the jar is shaded.
// Usage: node tools/nano-bridge/build.mjs [--check]   --check compiles and tests, and leaves the shipped jar alone.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '..', 'main', 'minecraft', 'players', 'NanoBridge.jar');
const REPO = 'https://repo.papermc.io/repository/maven-public/';
// The oldest: 1.20.1's version.json in the Gradle cache asks for Java 17. The newest is what the real server runs.
const OLDEST = '1.20.1-R0.1-SNAPSHOT';
const NEWEST = '26.3.build.236-stable';

const get = async (url) => {
  if (!url.startsWith(REPO)) throw new Error(`${url} is not on repo.papermc.io`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const tags = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const tag = (xml, name) => tags(xml, name)[0]?.trim();
const mavenPath = (group, artifact, version) => `${group.replace(/\./g, '/')}/${artifact}/${version}/`;

// A snapshot's files carry a time stamp that its maven-metadata.xml names.
async function fileName(group, artifact, version, ext) {
  if (!version.endsWith('-SNAPSHOT')) return `${artifact}-${version}.${ext}`;
  const meta = (await get(`${REPO}${mavenPath(group, artifact, version)}maven-metadata.xml`)).toString();
  const stamped = tags(meta, 'snapshotVersion').find((v) => tag(v, 'extension') === ext && !v.includes('<classifier>'));
  return `${artifact}-${tag(stamped, 'value')}.${ext}`;
}
async function pomOf(group, artifact, version) {
  const name = await fileName(group, artifact, version, 'pom');
  return (await get(`${REPO}${mavenPath(group, artifact, version)}${name}`)).toString();
}
// What a pom's dependencyManagement fixes, with the BOMs it imports.
async function managed(pom, versions) {
  for (const dep of tags(tags(pom, 'dependencyManagement')[0] ?? '', 'dependency')) {
    const [g, a, v] = [tag(dep, 'groupId'), tag(dep, 'artifactId'), tag(dep, 'version')];
    if (tag(dep, 'scope') === 'import') await managed(await pomOf(g, a, v), versions);
    else if (v && !versions.has(`${g}:${a}`)) versions.set(`${g}:${a}`, v);
  }
}
// The compile class path of an artifact, from repo.papermc.io, into dir.
async function fetchClassPath(group, artifact, version, dir, jars = new Map(), versions = new Map()) {
  const key = `${group}:${artifact}`;
  if (jars.has(key)) return jars;
  jars.set(key, null);
  const pom = await pomOf(group, artifact, version);
  await managed(pom, versions);
  const name = await fileName(group, artifact, version, 'jar');
  const data = await get(`${REPO}${mavenPath(group, artifact, version)}${name}`);
  const sha1 = (await get(`${REPO}${mavenPath(group, artifact, version)}${name}.sha1`)).toString().trim().split(/\s/)[0];
  if (crypto.createHash('sha1').update(data).digest('hex') !== sha1) throw new Error(`${name}: checksum mismatch`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  jars.set(key, file);
  const body = pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  for (const dep of tags(body, 'dependency')) {
    const scope = tag(dep, 'scope') ?? 'compile';
    if (scope !== 'compile' && scope !== 'runtime') continue;
    if (tag(dep, 'optional') === 'true') continue;
    const [g, a] = [tag(dep, 'groupId'), tag(dep, 'artifactId')];
    const v = versions.get(`${g}:${a}`) ?? tag(dep, 'version');
    // A version in ${...} is a property of a parent pom, in what only the API's own build needs.
    if (v && !v.includes('$')) await fetchClassPath(g, a, v, dir, jars, versions).catch((err) => console.log(`skipped ${g}:${a}:${v}: ${err.message}`));
  }
  return jars;
}
function cachedApi(version) {
  const root = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', 'io.papermc.paper', 'paper-api', version);
  if (!fs.existsSync(root)) return null;
  const jars = fs.readdirSync(root, { recursive: true }).filter((f) => /paper-api-.*\.jar$/.test(f) && !/sources/.test(f));
  return jars.length ? path.join(root, jars[0]) : null;
}

const sources = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.java')).map((f) => path.join(dir, f));
const q = (s) => `"${s.replace(/\\/g, '/')}"`;
function javac(release, classPath, files, out, temp) {
  fs.mkdirSync(out, { recursive: true });
  const args = path.join(temp, `args-${path.basename(out)}.txt`);
  fs.writeFileSync(args, ['--release', String(release), '-encoding', 'UTF-8', '-proc:none', '-Xlint:-options', '-d', q(out), '-cp', q(classPath.join(path.delimiter)), ...files.map(q)].join('\n'));
  execFileSync('javac', [`@${args}`], { stdio: 'inherit' });
}
const java = (classPath, main, ...args) => execFileSync('java', ['-cp', classPath.join(path.delimiter), main, ...args], { stdio: 'inherit' });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-bridge-'));
try {
  const cached = cachedApi(OLDEST);
  console.log(cached ? `Paper API ${OLDEST} from the Gradle cache` : `Paper API ${OLDEST} is not in the Gradle cache: fetching it from repo.papermc.io`);
  const api = async (version, name) => {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    return [...(await fetchClassPath('io.papermc.paper', 'paper-api', version, dir)).values()].filter(Boolean);
  };
  const oldest = cached ? [cached] : await api(OLDEST, 'oldest');
  const newest = await api(NEWEST, 'newest');

  const main = path.join(temp, 'classes');
  javac(17, oldest, sources(path.join(here, 'src')), main, temp);
  fs.copyFileSync(path.join(here, 'plugin.yml'), path.join(main, 'plugin.yml'));
  const jarFile = path.join(temp, 'NanoBridge.jar');
  // A fixed date: the same sources give the same bytes.
  execFileSync('jar', ['--create', '--file', jarFile, '--date=2026-01-01T00:00:00Z', '-C', main, '.'], { stdio: 'inherit' });

  const tests = path.join(temp, 'test-classes');
  javac(17, [jarFile, ...oldest], sources(path.join(here, 'test')), tests, temp);
  console.log(`--- tests against ${OLDEST}`);
  java([tests, jarFile, ...oldest], 'dev.nanostudio.bridge.BridgeTest', path.join(temp, 'run-oldest'), jarFile);
  console.log(`--- the same classes against ${NEWEST}, which proves they link`);
  java([tests, jarFile, ...newest], 'dev.nanostudio.bridge.BridgeTest', path.join(temp, 'run-newest'), jarFile);
  console.log(`--- src compiled against ${NEWEST}`);
  javac(25, newest, sources(path.join(here, 'src')), path.join(temp, 'classes-newest'), temp);

  const size = fs.statSync(jarFile).size;
  if (process.argv.includes('--check')) console.log(`jar ${size} bytes, not written (--check)`);
  else {
    fs.copyFileSync(jarFile, OUT);
    console.log(`${OUT}: ${size} bytes, sha256 ${crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex')}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
