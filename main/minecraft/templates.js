// What the minecraft plugin writes into a server: a resource pack's pack.mcmeta, and a Velocity proxy's wiring to the
// project's servers.
const fs = require('fs');
const path = require('path');
const { atLeast } = require('./anti-xray');
const { writeProperties } = require('./server-settings');

// A key=value in a .properties file, set (added when missing).
const setProperty = (file, key, value) => writeProperties(file, { [key]: value });
// Line ends as LF, so the patterns below see one form (Velocity and Paper read either).
const readLf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '');

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
  // The table runs to the next one or to the end of the file.
  const re = /^\[servers\][ \t]*$[\s\S]*?(?=^\[|(?![\s\S]))/m;
  const lf = text.replace(/\r\n/g, '\n');
  return re.test(lf) ? lf.replace(re, () => table) : `${lf.replace(/\n?$/, '\n\n')}${table}`;
}
// Modern forwarding with the secret file, which the Paper servers behind the proxy are given: a velocity.toml made
// elsewhere (an imported proxy) may say otherwise, and its backends would then refuse every player it sends.
function setVelocityForwarding(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const at = lf.search(/^\[/m);
  let head = at < 0 ? lf : lf.slice(0, at);
  for (const [key, value] of [['player-info-forwarding-mode', '"MODERN"'], ['forwarding-secret-file', '"forwarding.secret"']]) {
    const re = new RegExp(`^${key}[ \\t]*=.*$`, 'm');
    head = re.test(head) ? head.replace(re, () => `${key} = ${value}`) : `${head.replace(/\n*$/, head.trim() ? '\n' : '')}${key} = ${value}\n\n`;
  }
  return head + (at < 0 ? '' : lf.slice(at));
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
  let text = readLf(file);
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
    const text = readLf(file);
    const block = blockRe(where.key).exec(text)?.[0];
    if (!block || !/^ {4}enabled: true$/m.test(block)) continue;
    fs.writeFileSync(file, text.replace(blockRe(where.key), () => block.replace(/^ {4}enabled: true$/m, '    enabled: false')));
    was = true;
  }
  if (was) setProperty(path.join(serverDir, 'server.properties'), 'online-mode', 'true');
  return was;
}

module.exports = { setProperty, packMcmeta, velocityToml, setVelocityServers, setVelocityForwarding, setPaperVelocity, unsetPaperVelocity, velocityConfig };
