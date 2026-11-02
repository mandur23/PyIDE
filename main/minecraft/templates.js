// What the minecraft plugin writes into a server: a resource pack's pack.mcmeta, and a Velocity proxy's wiring to the
// project's servers.
const fs = require('fs');
const path = require('path');

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
// A Paper backend behind Velocity: modern forwarding with the proxy's secret in config/paper-global.yml (the
// proxies.velocity block), and online-mode off in server.properties since the proxy checks the players' accounts.
function setPaperVelocity(serverDir, secret) {
  const file = path.join(serverDir, 'config', 'paper-global.yml');
  const block = `  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^ {2}velocity:\n(?: {4}.*\n)*/m.test(text)) text = text.replace(/^ {2}velocity:\n(?: {4}.*\n)*/m, () => block);
  else if (/^proxies:\n/m.test(text)) text = text.replace(/^proxies:\n/m, () => `proxies:\n${block}`);
  else text = `${text.replace(/\n?$/, text ? '\n' : '')}proxies:\n${block}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  setProperty(path.join(serverDir, 'server.properties'), 'online-mode', 'false');
}

module.exports = { setProperty, packMcmeta, velocityToml, setVelocityServers, setPaperVelocity };
