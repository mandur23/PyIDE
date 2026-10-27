// Spring Boot projects from Spring Initializr (start.spring.io, or the server the user names, like IntelliJ's Server
// URL): its options (languages, packagings, Spring Boot and Java versions, dependencies) for New Project, and the
// generated project unpacked into the folder the wizard just created. PYIDE_INITIALIZR_URL changes the default server
// (tests use a local one).
const fs = require('fs');
const os = require('os');
const path = require('path');
const trust = require('../trust');
const { extractZip } = require('../zip');

const DEFAULT_SERVER = () => process.env.PYIDE_INITIALIZR_URL || 'https://start.spring.io';
const TYPES = new Set(['maven-project', 'gradle-project', 'gradle-project-kotlin']); // Gradle with a Groovy or Kotlin script
const LANGUAGES = new Set(['java', 'kotlin', 'groovy']);
const PACKAGINGS = new Set(['jar', 'war']);
const TEXT = /^[\w.-]{1,100}$/;
const TIMEOUT = 30000;

// No network, a refused request or a lost download is the wizard's to show, not an IDE internal error.
const expected = (message) => Object.assign(new Error(message), { expected: true });

function base(server) {
  const url = String(server || DEFAULT_SERVER()).trim();
  let u;
  try { u = new URL(url); } catch { throw expected(`Not a server URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw expected(`Not a server URL: ${url}`);
  return u.href.replace(/\/+$/, '');
}

async function get(url, accept = '*/*') {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw expected(`${new URL(url).host}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
  // Initializr explains a refused request (a dependency the Spring Boot version lacks) in a JSON message.
  if (!res.ok) {
    const why = await res.json().then((j) => j.message, () => '');
    throw expected(`${new URL(url).host} answered HTTP ${res.status}${why ? `: ${why}` : ''}`);
  }
  return res;
}

// Only what the form shows: a select's default and choices, and the dependency groups.
const choices = (s = {}, keep = null) => {
  const values = (s.values || []).map(({ id, name }) => ({ id, name })).filter((v) => !keep || keep.has(v.id));
  return { default: values.some((v) => v.id === s.default) ? s.default : values[0]?.id, values };
};
const metadata = (m) => ({
  language: choices(m.language, LANGUAGES),
  packaging: choices(m.packaging, PACKAGINGS),
  bootVersion: choices(m.bootVersion),
  javaVersion: choices(m.javaVersion),
  dependencies: (m.dependencies?.values || []).map((g) => ({
    name: g.name,
    values: (g.values || []).map(({ id, name, description, versionRange }) => ({ id, name, description, versionRange })),
  })),
});

// The generated application class: the .java, .kt or .groovy file under src/main with @SpringBootApplication.
function findMain(dir) {
  const stack = [path.join(dir, 'src', 'main')];
  while (stack.length) {
    const d = stack.pop();
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (/\.(java|kt|groovy)$/.test(e.name) && fs.readFileSync(abs, 'utf8').includes('@SpringBootApplication')) return path.relative(dir, abs);
    }
  }
  return null;
}

exports.register = ({ ipcMain }) => {
  // Downloaded projects waiting for their folder: New Project downloads before it creates the folder, so a refused
  // request leaves nothing behind and the wizard open.
  const downloads = new Map(); // id -> zip bytes
  let next = 0;

  ipcMain.handle('spring:defaultServer', () => DEFAULT_SERVER());
  ipcMain.handle('spring:metadata', async (_e, server) => metadata(await (await get(base(server), 'application/vnd.initializr.v2.2+json')).json()));

  // p: {server?, type, language, packaging, bootVersion, javaVersion, groupId, artifactId, name, packageName,
  // dependencies: [id]} -> id
  ipcMain.handle('spring:download', async (_e, p = {}) => {
    if (!TYPES.has(p.type)) throw new Error(`Unknown project type ${p.type}`);
    const language = p.language || 'java';
    const packaging = p.packaging || 'jar';
    if (!LANGUAGES.has(language) || !PACKAGINGS.has(packaging)) throw new Error(`Unknown language or packaging ${language} ${packaging}`);
    const q = new URLSearchParams({ type: p.type, language, packaging });
    for (const k of ['bootVersion', 'javaVersion', 'groupId', 'artifactId', 'name', 'packageName']) {
      if (!TEXT.test(String(p[k] ?? ''))) throw new Error(`Bad ${k}: ${p[k]}`);
      q.set(k, p[k]);
    }
    const deps = (p.dependencies || []).filter((d) => TEXT.test(d));
    if (deps.length) q.set('dependencies', deps.join(','));
    const bytes = Buffer.from(await (await get(`${base(p.server)}/starter.zip?${q}`)).arrayBuffer());
    const id = ++next;
    downloads.set(id, bytes);
    for (const old of downloads.keys()) if (downloads.size > 3) downloads.delete(old);
    return id;
  });

  // dir: the new project folder (New Project trusts it) -> {main: the application class, relative}
  ipcMain.handle('spring:unpack', (_e, id, dir) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !trust.isTrusted(dir)) throw new Error('Not a new project folder');
    const bytes = downloads.get(id);
    if (!bytes) throw expected('The project download is gone; create the project again');
    downloads.delete(id);
    const zip = path.join(os.tmpdir(), `pyide-initializr-${process.pid}-${id}.zip`);
    try {
      fs.writeFileSync(zip, bytes);
      extractZip(zip, dir);
    } finally {
      fs.rmSync(zip, { force: true });
    }
    return { main: findMain(dir) };
  });
};
