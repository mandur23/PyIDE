// Where each kind of Minecraft server comes from: the Minecraft versions it offers and the file to download for one.
// Every list and file comes from the project's own service: Mojang's version manifest (which also says the Java
// version each Minecraft version needs), PaperMC's Fill API, Fabric's meta API (and Quilt's, for the launcher's
// clients), and the Forge and NeoForge Maven repositories. PYIDE_MC_SOURCES (tests) is a JSON object whose keys replace the base URLs below.
const BASE = {
  mojang: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  paper: 'https://fill.papermc.io/v3/projects/paper',
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3',
  forge: 'https://maven.minecraftforge.net/net/minecraftforge/forge',
  forgePromos: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  neoforge: 'https://maven.neoforged.net/releases/net/neoforged/neoforge',
  neoforgeMdk: 'https://github.com/NeoForgeMDKs',
  fabricMdk: 'https://github.com/FabricMC/fabric-example-mod',
  purpur: 'https://api.purpurmc.org/v2/purpur',
  velocity: 'https://fill.papermc.io/v3/projects/velocity',
  adoptium: 'https://api.adoptium.net/v3',
  modrinth: 'https://api.modrinth.com/v2',
  mojangApi: 'https://api.mojang.com',
};
// Only text values replace a base URL, without a trailing slash (the paths below add their own).
const base = () => {
  let own = {};
  try { own = JSON.parse(process.env.PYIDE_MC_SOURCES || '{}') || {}; } catch {}
  return { ...BASE, ...Object.fromEntries(Object.entries(own).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.replace(/\/+$/, '')])) };
};
// Whether url is on the origin of a base URL PYIDE_MC_SOURCES replaced: a test's local stand-in, which may serve
// what otherwise only comes from https or from the hosts a modpack may name.
const originOf = (u) => { try { const o = new URL(u).origin; return o === 'null' ? null : o; } catch { return null; } };
const standIn = (url) => {
  const o = originOf(url);
  return !!o && Object.entries(base()).some(([k, v]) => v !== BASE[k] && originOf(v) === o);
};
// PaperMC refuses requests without a User-Agent that names the program.
const HEADERS = { 'User-Agent': `NanoStudio/${require('../../package.json').version} (https://github.com/mandur23/PyIDE)` };

// A service that does not answer within TIMEOUT is given up on. What goes wrong is the service's or the network's, the
// user's to see and not an IDE error: the errors are marked expected, and an HTTP error carries its status.
const TIMEOUT = 30000;
const fail = (message, more) => Object.assign(new Error(message), { expected: true, ...more });
async function getText(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw fail(`${url}: HTTP ${res.status}`, { status: res.status });
    return await res.text();
  } catch (err) {
    if (err.expected) throw err;
    throw fail(err.name === 'TimeoutError' ? `${url}: no answer within ${TIMEOUT / 1000} seconds` : `${url}: ${err.cause?.message || err.message}`);
  }
}
async function getJson(url) {
  const text = await getText(url);
  try { return JSON.parse(text); } catch { throw fail(`${url}: the answer is not JSON`); }
}

// A Minecraft account by its name, from Mojang's profile API ({name, id}: the id is the UUID without dashes); null
// when no account has that name (404, or an empty 204 answer).
async function mojangProfile(name) {
  let text;
  try { text = await getText(`${base().mojangApi}/users/profiles/minecraft/${encodeURIComponent(name)}`); } catch (err) {
    if (err.status === 404 || err.status === 204) return null;
    throw err;
  }
  let p = null;
  try { p = text.trim() ? JSON.parse(text) : null; } catch { throw fail('Mojang\'s profile service answered with something other than JSON'); }
  return p && /^[0-9a-f]{32}$/i.test(p.id || '') ? { name: String(p.name || name), id: p.id.toLowerCase() } : null;
}

// Newest first by numeric parts: 26.3 > 26.1.2 > 1.21.11 > 1.21.2.
const byVersion = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
};
const RELEASE = /^\d+(\.\d+)+$/;

let manifest = null;
async function mojangManifest() {
  manifest ||= getJson(base().mojang).catch((e) => { manifest = null; throw e; });
  return manifest;
}
async function mojangVersion(mc) {
  const entry = (await mojangManifest()).versions.find((v) => v.id === mc);
  if (!entry) throw new Error(`Minecraft ${mc} is not in Mojang's version list`);
  return getJson(entry.url);
}
// The Java a Minecraft version runs on, from Mojang's own version file (8 for the oldest, which do not say).
async function javaFor(mc) {
  return (await mojangVersion(mc)).javaVersion?.majorVersion || 8;
}

// NeoForge numbers its versions after Minecraft's: 21.1.265 is for 1.21.1, 20.4.x for 1.20.4, 26.3.0.99 for 26.3 and
// 26.1.2.124 for 26.1.2.
function neoforgeMc(v) {
  const parts = v.replace(/-.*$/, '').split('.');
  if (Number(parts[0]) >= 26) {
    const mc = parts.slice(0, parts.length - 1);
    if (mc.length === 3 && mc[2] === '0') mc.pop();
    return mc.join('.');
  }
  return parts[1] === '0' ? `1.${parts[0]}` : `1.${parts[0]}.${parts[1]}`;
}

// A Fill v3 project (Paper, Velocity): the newest STABLE build of a version, else the newest build.
async function fillBuild(projectUrl, version, title) {
  const builds = await getJson(`${projectUrl}/versions/${version}/builds`);
  const list = Array.isArray(builds) ? builds : [];
  const build = list.filter((b) => b.channel === 'STABLE').sort((a, b) => b.id - a.id)[0] || list.sort((a, b) => b.id - a.id)[0];
  const dl = build?.downloads?.['server:default'];
  if (!dl) throw new Error(`${title} has no build for ${version}`);
  return { file: 'server.jar', url: dl.url, sha256: dl.checksums?.sha256, size: dl.size, build: build.id };
}
const fillVersions = async (projectUrl) => Object.values((await getJson(projectUrl)).versions || {}).flat().filter((v) => RELEASE.test(v)).sort(byVersion);

// kind -> {title, plugins: the plugin API that runs on it ('paper' for Paper and its forks, 'velocity'), mods: the
// mod loader players need, proxy: it fronts other servers, java?: the Java it needs when that is not Minecraft's,
// versions(), resolve(mc)}. resolve gives {file, url, sha256?, sha1?, md5?, loader?, build?, installer?: true, mdk?}
// where installer means the file is an installer run with --installServer and mdk the mod template's zip (a list
// to try in order when it is not certain to exist). A mod loader's resolve takes the loader version wanted (a
// modpack names the one it was made with); without one it picks the recommended or newest.
const KINDS = {
  paper: {
    title: 'Paper', plugins: 'paper', mods: null,
    versions: () => fillVersions(base().paper),
    resolve: (mc) => fillBuild(base().paper, mc, 'Paper'),
  },
  purpur: {
    title: 'Purpur', plugins: 'paper', mods: null,
    async versions() {
      return ((await getJson(base().purpur)).versions || []).filter((v) => RELEASE.test(v)).sort(byVersion);
    },
    async resolve(mc) {
      const latest = await getJson(`${base().purpur}/${mc}/latest`);
      if (!latest?.build) throw new Error(`Purpur has no build for ${mc}`);
      return { file: 'server.jar', url: `${base().purpur}/${mc}/${latest.build}/download`, md5: latest.md5, build: Number(latest.build) };
    },
  },
  velocity: {
    // A proxy: players join it and it sends them on to the project's Paper and Purpur servers. Its versions are its
    // own, not Minecraft's, so the Java it needs is read from its jar (4.x is built for Java 25).
    title: 'Velocity', plugins: 'velocity', mods: null, proxy: true, java: 'jar',
    versions: () => fillVersions(base().velocity),
    resolve: (v) => fillBuild(base().velocity, v, 'Velocity'),
  },
  vanilla: {
    title: 'Vanilla', plugins: false, mods: null,
    async versions() {
      return (await mojangManifest()).versions.filter((v) => v.type === 'release').map((v) => v.id);
    },
    async resolve(mc) {
      const server = (await mojangVersion(mc)).downloads?.server;
      if (!server) throw new Error(`Mojang publishes no server for ${mc}`);
      return { file: 'server.jar', url: server.url, sha1: server.sha1, size: server.size };
    },
  },
  fabric: {
    title: 'Fabric', plugins: false, mods: 'fabric-loader',
    async versions() {
      return (await getJson(`${base().fabric}/versions/game`)).filter((v) => v.stable).map((v) => v.version);
    },
    async resolve(mc, wanted) {
      const loader = wanted || (await getJson(`${base().fabric}/versions/loader/${mc}`)).find((l) => l.loader?.stable)?.loader.version;
      const installer = (await getJson(`${base().fabric}/versions/installer`)).find((i) => i.stable)?.version;
      if (!loader || !installer) throw new Error(`Fabric has no loader for ${mc}`);
      // The official example mod keeps a branch per Minecraft version.
      return { file: 'server.jar', url: `${base().fabric}/versions/loader/${mc}/${loader}/${installer}/server/jar`, loader,
        mdk: [`${base().fabricMdk}/archive/refs/heads/${mc}.zip`] };
    },
  },
  forge: {
    title: 'Forge', plugins: false, mods: 'forge',
    async versions() {
      const promos = (await getJson(base().forgePromos)).promos || {};
      return [...new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, '')))].filter((v) => RELEASE.test(v)).sort(byVersion);
    },
    async resolve(mc, wanted) {
      const promos = (await getJson(base().forgePromos)).promos || {};
      const loader = wanted || promos[`${mc}-recommended`] || promos[`${mc}-latest`];
      if (!loader) throw new Error(`Forge has no build for ${mc}`);
      const name = `forge-${mc}-${loader}-installer.jar`;
      const url = `${base().forge}/${mc}-${loader}/${name}`;
      const sha256 = (await getText(`${url}.sha256`).catch(() => '')).trim().split(/\s/)[0] || undefined;
      return { file: name, url, sha256, loader, installer: true, mdk: [`${base().forge}/${mc}-${loader}/forge-${mc}-${loader}-mdk.zip`] };
    },
  },
  neoforge: {
    title: 'NeoForge', plugins: false, mods: 'neoforge',
    async allVersions() {
      const xml = await getText(`${base().neoforge}/maven-metadata.xml`);
      return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    },
    async versions() {
      const all = await this.allVersions();
      return [...new Set(all.filter((v) => !/-/.test(v)).map(neoforgeMc))].filter((v) => RELEASE.test(v)).sort(byVersion);
    },
    async resolve(mc, wanted) {
      const all = (await this.allVersions()).filter((v) => neoforgeMc(v) === mc);
      const loader = wanted || all.filter((v) => !/-/.test(v)).sort(byVersion)[0] || all.sort(byVersion)[0];
      if (!loader) throw new Error(`NeoForge has no build for ${mc}`);
      const name = `neoforge-${loader}-installer.jar`;
      const url = `${base().neoforge}/${loader}/${name}`;
      const sha256 = (await getText(`${url}.sha256`).catch(() => '')).trim().split(/\s/)[0] || undefined;
      // NeoForge publishes an MDK repository per Minecraft version, some weeks after the version: a newer one without
      // its own MDK starts from the nearest older one of the same year (26.3 from 26.2, then 26.1), whose
      // gradle.properties the mod's creation points at this version (newMod).
      const [major, minor] = mc.split('.').map(Number);
      const older = major >= 26 ? Array.from({ length: minor - 1 }, (_v, i) => `${major}.${minor - 1 - i}`) : [];
      return { file: name, url, sha256, loader, installer: true, mdk: [mc, ...older].map((v) => `${base().neoforgeMdk}/MDK-${v}-ModDevGradle/archive/refs/heads/main.zip`) };
    },
  },
};

// Temurin for a Java major version from Adoptium: {url, sha256, size, name}. A JRE runs a server; Gradle builds need
// the JDK.
async function temurin(major, jdk) {
  const list = await getJson(`${base().adoptium}/assets/latest/${major}/hotspot?architecture=x64&image_type=${jdk ? 'jdk' : 'jre'}&os=windows&vendor=eclipse`);
  const pkg = list.map((a) => a.binary?.package).find((p) => p?.link?.endsWith('.zip'));
  if (!pkg) throw new Error(`Adoptium has no Java ${major} ${jdk ? 'JDK' : 'JRE'} for Windows`);
  return { url: pkg.link, sha256: pkg.checksum, size: pkg.size, name: pkg.name };
}

const modrinthApi = () => base().modrinth;

module.exports = { KINDS, RELEASE, base, standIn, javaFor, mojangVersion, temurin, neoforgeMc, byVersion, HEADERS, getText, getJson, modrinthApi, mojangProfile };
