// What the minecraft plugin writes into a server: a resource pack's pack.mcmeta, and a Velocity proxy's wiring to the
// project's servers.
const fs = require('fs');
const path = require('path');
const { atLeast } = require('./anti-xray');

// A key=value in a .properties file, set (added when missing).
function setProperty(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key.replace(/[.]/g, '\\.')}\\s*=.*$`, 'm');
  // A function replacement: a value's $& or $1 is text, not a pattern.
  fs.writeFileSync(file, re.test(text) ? text.replace(re, () => `${key}=${value}`) :`${text.replace(/\n?$/, '\n')}${key}=${value}\n`);
}

// ---------- resource pack ----------
// version.json's pack_version is {resource, data} up to 1.21.8 and {resource_major, resource_minor, ...} after; packs
// for format 65 and later declare min_format/max_format instead of pack_format.
function packMcmeta(packVersion, description) {
  const major = packVersion?.resource_major ?? packVersion?.resource ?? packVersion;
  const minor = packVersion?.resource_minor ?? 0;
  const pack = major >= 65
    ? { description, min_format: major, max_format: minor ? [major, minor] : major }
    : { description, pack_format: major };
  return `${JSON.stringify({ pack }, null, 2)}\n`;
}

// ---------- Velocity ----------
// velocity.toml for players on `port`, sending them on to `backends` ([{name, port}]) with modern forwarding.
// Velocity takes its defaults for every key not written here.
function velocityToml(port, backends) {
  const servers = backends.map((b) => `${JSON.stringify(b.name)} = "127.0.0.1:${b.port}"`).join('\n');
  return `# Written by Nano Studio: the [servers] table lists the project's Paper and Purpur servers each time the proxy starts.
config-version = "2.9"
bind = "0.0.0.0:${port}"
online-mode = true
player-info-forwarding-mode = "MODERN"
forwarding-secret-file = "forwarding.secret"

[servers]
${servers}
try = [${backends.map((b) => JSON.stringify(b.name)).join(', ')}]

[forced-hosts]
`;
}
// The [servers] table of an existing velocity.toml replaced by the project's backends.
function setVelocityServers(text, backends) {
  const table = `[servers]\n${backends.map((b) => `${JSON.stringify(b.name)} = "127.0.0.1:${b.port}"`).join('\n')}\ntry = [${backends.map((b) => JSON.stringify(b.name)).join(', ')}]\n\n`;
  return /^\[servers\][\s\S]*?(?=^\[)/m.test(text) ? text.replace(/^\[servers\][\s\S]*?(?=^\[)/m, () => table) : `${text.replace(/\n?$/, '\n\n')}${table}`;
}
// Where a Paper or Purpur of Minecraft `mc` reads modern forwarding: config/paper-global.yml's proxies.velocity from
// 1.19, paper.yml's settings.velocity-support from 1.13 to 1.18. null before 1.13, which has no modern forwarding.
const VELOCITY_FILES = {
  global: { file: ['config', 'paper-global.yml'], parent: 'proxies', key: 'velocity' },
  legacy: { file: ['paper.yml'], parent: 'settings', key: 'velocity-support' },
};
const velocityConfig = (mc) => (atLeast(mc, 1, 19) ? VELOCITY_FILES.global : atLeast(mc, 1, 13) ? VELOCITY_FILES.legacy : null);
const blockRe = (key) => new RegExp(`^ {2}${key}:\\n(?: {4}.*\\n)*`, 'm');
// A Paper backend behind Velocity: modern forwarding with the proxy's secret in the file its version reads, and
// online-mode off in server.properties since the proxy checks the players' accounts. false (nothing written) for a
// Minecraft older than 1.13: with account checks off and no forwarding to check, anyone could join as anyone.
function setPaperVelocity(serverDir, secret, mc) {
  const where = velocityConfig(mc);
  if (!where) return false;
  const file = path.join(serverDir, ...where.file);
  const block = `  ${where.key}:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (blockRe(where.key).test(text)) text = text.replace(blockRe(where.key), () => block);
  else if (new RegExp(`^${where.parent}:\\n`, 'm').test(text)) text = text.replace(new RegExp(`^${where.parent}:\\n`, 'm'), () => `${where.parent}:\n${block}`);
  else text = `${text.replace(/\n?$/, text ? '\n' : '')}${where.parent}:\n${block}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  setProperty(path.join(serverDir, 'server.properties'), 'online-mode', 'false');
  return true;
}
// A backend no proxy sends players to any more: forwarding off wherever it is on (either file: an older Nano Studio
// wrote paper-global.yml for every version), and the server checks accounts itself again. -> whether it was on.
function unsetPaperVelocity(serverDir) {
  let was = false;
  for (const where of Object.values(VELOCITY_FILES)) {
    const file = path.join(serverDir, ...where.file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const block = blockRe(where.key).exec(text)?.[0];
    if (!block || !/^ {4}enabled: true$/m.test(block)) continue;
    fs.writeFileSync(file, text.replace(blockRe(where.key), () => block.replace(/^ {4}enabled: true$/m, '    enabled: false')));
    was = true;
  }
  if (was) setProperty(path.join(serverDir, 'server.properties'), 'online-mode', 'true');
  return was;
}

module.exports = { setProperty, packMcmeta, velocityToml, setVelocityServers, setPaperVelocity, unsetPaperVelocity, velocityConfig };
