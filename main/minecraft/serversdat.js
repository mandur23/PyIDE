// servers.dat, the game's Multiplayer list, in an instance's game folder: uncompressed NBT, a root compound with a
// `servers` list of compounds (ip, name, and icon, acceptTextures, hidden when the game has set them). Entries are merged
// by address and the rest of the file comes back as it was, every tag the game or a newer game added included. A file
// that cannot be read is the user's list and is left alone, with a copy beside it. The list is a convenience: Join's
// Quick Play works without it, so the caller carries on whatever happens here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseNbt, writeNbt } = require('./players/nbt');

const FILE = 'servers.dat';
const STRING = 8;
const LIST = 9;
const COMPOUND = 10;

const damaged = (why) => Object.assign(new Error(`servers.dat is damaged: ${why}`), { expected: true, code: 'damaged' });

function emptyList() {
  const servers = [];
  servers.item = COMPOUND;
  return { type: LIST, value: servers };
}

function readRoot(file) {
  if (!fs.existsSync(file)) return Object.assign(Object.create(null), { servers: emptyList() });
  const root = parseNbt(fs.readFileSync(file), { tagged: true });
  if (!root.servers) root.servers = emptyList();
  const { type, value } = root.servers;
  if (type !== LIST || (value.length && value.item !== COMPOUND)) throw damaged('its servers are not a list of compounds');
  value.item = COMPOUND;
  return root;
}

// Named by its content, so reading the same damaged file at every Play leaves one copy.
function keepDamaged(file) {
  const data = fs.readFileSync(file);
  const copy = `${file}.damaged-${crypto.createHash('sha1').update(data).digest('hex').slice(0, 8)}`;
  if (!fs.existsSync(copy)) fs.writeFileSync(copy, data);
}

const holds = (entry, ip) => String(entry.ip?.value).toLowerCase() === ip.toLowerCase();
const entryOf = ({ ip, name }) => Object.assign(Object.create(null), { ip: { type: STRING, value: ip }, name: { type: STRING, value: name } });

// wanted: [{ip, name, was?}], was being an address this entry held before (a private server's new local port). An entry
// the user has renamed keeps its name. The game keeps a server joined by Quick Play as a hidden entry, which its list
// does not show. -> {written, damaged?}. A file that already says all this is not touched.
function mergeServers(dir, wanted, { rename = fs.renameSync } = {}) {
  const file = path.join(dir, FILE);
  let root;
  try {
    root = readRoot(file);
  } catch (err) {
    if (err.code !== 'damaged') throw err;
    keepDamaged(file);
    return { written: false, damaged: true };
  }
  const list = root.servers.value;
  let changed = false;
  for (const { ip, name, was } of wanted) {
    const old = was ? list.findIndex((e) => holds(e, was)) : -1;
    const entry = list.find((e) => holds(e, ip));
    if (entry && old >= 0) list.splice(old, 1);
    else if (old >= 0) list[old].ip.value = ip;
    else if (!entry) list.push(entryOf({ ip, name }));
    const held = entry || (old >= 0 ? list[old] : null);
    changed ||= old >= 0 || !entry;
    if (held?.hidden?.value) {
      held.hidden.value = 0;
      changed = true;
    }
  }
  if (!changed) return { written: false };
  const tmp = `${file}.nano-tmp`;
  try {
    fs.writeFileSync(tmp, writeNbt(root));
    rename(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { written: true };
}

module.exports = { mergeServers };
