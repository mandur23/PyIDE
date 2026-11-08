// Whether a host name leads to this computer or its network: what launcher.js's literal check (PRIVATE_HOST) cannot see
// in a name such as localtest.me, which resolves to 127.0.0.1. The name is looked up as the game and fetch would look
// it up (dns.promises.lookup, every address), and, for a server address without a port, its _minecraft._tcp SRV
// record too, since the game then connects where that points.
// PYIDE_MC_DNS (tests): a JSON object that answers in place of DNS, {name: [address, …], "_minecraft._tcp.<name>":
// [{name, port}, …]}; a name it does not hold is not found. Nothing is then asked of the real DNS.
const dns = require('dns');
const net = require('net');

const LOOKUP_MS = 5000;
// Loopback, private, link-local, CGNAT and unspecified: the same ranges the literal check refuses.
const LOCAL = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) LOCAL.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) LOCAL.addSubnet(a, n, 'ipv6');
// An IPv4 address written as IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1) is that IPv4 address.
function mapped(ip) {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}
function isLocalIp(ip) {
  const s = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = net.isIPv4(s) ? s : mapped(s);
  if (v4) return LOCAL.check(v4, 'ipv4');
  return net.isIPv6(s) && LOCAL.check(s, 'ipv6');
}

const standIn = () => {
  if (process.env.PYIDE_MC_DNS === undefined) return null;
  try { const v = JSON.parse(process.env.PYIDE_MC_DNS); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
const notFound = (name) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
const inTime = (promise) => Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), LOOKUP_MS).unref?.(); })]);
// name -> its addresses; throws when it cannot be looked up.
async function addressesOf(name) {
  const own = standIn();
  if (own) {
    if (!Array.isArray(own[name])) throw notFound(name);
    return own[name].map(String);
  }
  return (await inTime(dns.promises.lookup(name, { all: true, verbatim: true }))).map((a) => a.address);
}
// The targets of the server's SRV record, [] when it has none.
async function srvOf(name) {
  const own = standIn();
  const key = `_minecraft._tcp.${name}`;
  if (own) return Array.isArray(own[key]) ? own[key].filter((r) => r && typeof r.name === 'string') : [];
  try { return await inTime(dns.promises.resolveSrv(key)); } catch { return []; }
}

// -> {local, addresses, failed}: local when any address the name leads to is this computer's or its network's; failed
// when the name itself could not be looked up (offline, unknown), which says nothing either way. srv: also follow the
// game's SRV record (a server address without a port).
async function resolvesLocal(name, { srv = false } = {}) {
  const host = String(name).replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { local: isLocalIp(host), addresses: [host], failed: false };
  const addresses = [];
  let failed = false;
  try { addresses.push(...await addressesOf(host)); } catch { failed = true; }
  if (srv) {
    for (const r of await srvOf(host)) {
      const target = r.name.replace(/\.$/, '');
      if (net.isIP(target)) addresses.push(target);
      else try { addresses.push(...await addressesOf(target)); } catch {}
    }
  }
  return { local: addresses.some(isLocalIp), addresses, failed };
}

module.exports = { resolvesLocal, isLocalIp };
