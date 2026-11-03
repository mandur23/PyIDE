// One line of a Minecraft server's console -> an event. What a player types arrives in the same stream as the server's
// own lines, so every pattern is anchored twice: on the whole line prefix of the server's logger, and on the full shape
// of the message. A message starting with `<Bob> ` is chat whatever it says after that, and no other shape can start
// with what a player controls. Only two kinds of line are believed by shape and a known name together (deaths and the
// plain command form): they have no fixed wording to anchor on, so `online` must hold the name.
const { isIPv6 } = require('net');

const NAME = '[A-Za-z0-9_.]{1,16}';
const TEXT_MAX = 512;

// Forge's debug log writes a date in front of the clock.
const CLOCK = '(?:\\d{2}[A-Za-z]{3}\\d{4} )?\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?';
// [12:00:00] [Server thread/INFO]: , Forge's ... [minecraft/MinecraftServer]: and Fabric's ... (Minecraft)
const THREADED = new RegExp(`^\\[${CLOCK}\\] \\[([^\\]/]{1,80})/([A-Z]{4,5})\\](?:: | \\[([^\\]\\s]{1,120})\\]: | \\(([^)\\s]{1,60})\\) )`);
// Paper and Purpur: [12:00:00 INFO]: . A plugin's line follows it as `[PluginName] text`.
const PAPER = new RegExp(`^\\[${CLOCK} ([A-Z]{4,5})\\]: `);
const OWN_LOGGER = /^(?:minecraft|net\.minecraft|ne\.mi)[./]/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const CHAT = /^(\[Not Secure\] )?<([^>]{1,80})> (.*)$/s;
const ME = new RegExp(`^(\\[Not Secure\\] )?\\* (${NAME}) (.*)$`, 's');
const SAY = new RegExp(`^(\\[Not Secure\\] )?\\[(${NAME})\\] (.*)$`, 's');
// Everything that starts like something a player typed: never a server event, never the answer to a query.
const TYPED = /^(?:\[Not Secure\] |<|\* |\[[^\]]*\] )/;

const UUID_LINE = new RegExp(`^UUID of player (${NAME}) is ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`);
const LOGIN = new RegExp(`^(${NAME})\\[(.{1,120}?)\\] logged in with entity id \\d+ at \\((?:\\[[^\\]]*\\])?(-?[\\d.]+(?:E-?\\d+)?), (-?[\\d.]+(?:E-?\\d+)?), (-?[\\d.]+(?:E-?\\d+)?)\\)$`);
const JOIN = new RegExp(`^(${NAME}) joined the game$`);
const RENAMED = new RegExp(`^(${NAME}) \\(formerly known as (${NAME})\\) joined the game$`);
const LEFT = new RegExp(`^(${NAME}) left the game$`);
const LOST = new RegExp(`^(${NAME}) lost connection: (.*)$`, 's');
const COMMAND = new RegExp(`^(${NAME}) issued server command: (/.*)$`, 's');
const ADMIN = new RegExp(`^\\[(${NAME}): (.*)\\]$`, 's');
const ADVANCEMENT = new RegExp(`^(${NAME}) has (?:made the advancement|completed the challenge|reached the goal|just earned the achievement) \\[(.+)\\]$`, 's');
// The heads of the game's death messages (en_us death.*, older wordings included). What follows a head is a mob's or a
// player's name and an item's, which a player can name, so nothing is read from the tail.
const DEATH = new RegExp(`^(${NAME}) (?:${[
  'was (?:squashed|squished|killed|shot|pricked|blown|fireballed|frozen|pummeled|slain|struck|stung|impaled|skewered|burned|burnt|roasted|obliterated|poked|doomed|smashed|speared|finished|knocked)',
  'drowned', 'died', 'blew up', 'hit the ground too hard', 'experienced kinetic energy', 'froze to death', 'went up in flames', 'went off with a bang',
  'walked into', 'discovered the floor was lava', 'suffocated in a wall', 'tried to swim in lava', 'burned to death', 'starved to death', 'withered away',
  'fell (?:from|off|out of|while|too far)', "didn't want to live", 'left the confines of this world', 'got finished off',
].join('|')})(?: .+)?$`, 's');
// 26.3's one death that starts with the killer, who can be a mob of any name. A named pet's own log line has its name in
// quotes and brackets, which is why those are not allowed here: a pet's name must not be able to kill someone else.
const DEATH_BY = new RegExp(`^[^\\['"]{1,80} showed (${NAME}) that not just the floor is lava(?: using .+)?$`, 's');
const DONE = /^Done \([^)]{1,20}\)! For help, type "help"/;
const STOPPING = /^Stopping (?:the )?server$/;
const STARTING = /^Starting minecraft server version \S+$/;

// Only ever the masked form leaves this module. An address it cannot read is dropped, not passed on.
function maskIp(address) {
  const v4 = /(?:^|[^\d.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?![\d.])/.exec(address);
  if (v4) return `${v4[1]}.${v4[2]}.*.*`;
  const v6 = /^\/?\[?([0-9a-fA-F]{1,4}):([0-9a-fA-F]{0,4}):/.exec(address);
  return v6 ? `${v6[1]}:${v6[2] || '0'}:*` : null;
}

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?!\.?\d)(?::\d{1,5}(?!\d))?/g;
// A run of hex and colons, which net decides: 12:00:00 is a time and not an address.
const IPV6 = /\[?(?<![\w:.])([0-9a-fA-F:]*:[0-9a-fA-F:]*:[0-9a-fA-F:]*)(?![\w:]|\.\d)(?:%\w+)?(?:\](?::\d{1,5}(?!\d))?)?/g;
const maskV6 = (whole, address) => (isIPv6(address) && /[0-9a-fA-F]/.test(address) ? maskIp(address) ?? '*' : whole);
// Each stored line passes here several times, on the server's output path, and few hold anything like an address.
const POSSIBLE = /\d\.\d+\.\d|:[0-9a-fA-F]*:/;
// Anything shaped like an address, with its port. Running it twice changes nothing.
const maskAddresses = (s) => (POSSIBLE.test(s) ? s.replace(IPV6, maskV6).replace(IPV4, '$1.$2.*.*') : s);

// Text kept or shown: no control characters, no § format codes, no address, no more than a stored line may hold. Masked
// before the cut, which could leave three parts of an address that no longer has the shape of one.
const clean = (s) => maskAddresses(String(s).replace(/§./gs, '').replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, TEXT_MAX);

// The line's prefix -> {msg, level, thread, own, server}, or null for a line without one. own: from Minecraft's own
// logger, not a mod's or a plugin's; server: on the server thread (or a format that does not name the thread), at a
// level a command's answer comes at.
const plain = (raw) => (raw.includes('\x1b') ? raw.replace(ANSI, '') : raw);

// 26.3 logs what the server tells its console behind this, and the console is told both the answers to commands and every
// broadcast: joins, deaths, advancements. 1.20.1 logs them bare. Chat has its own logger and never has it, so what follows
// is the server's and no player can start a line with it.
const SYSTEM_CHAT = 'System chat: ';
const unwrapped = (msg) => (msg.startsWith(SYSTEM_CHAT) ? msg.slice(SYSTEM_CHAT.length) : msg);

function split(raw) {
  let line = plain(raw);
  if (line.charCodeAt(0) !== 91) line = line.replace(/^[\r>\s]+/, '');
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.charCodeAt(0) !== 91) return null;
  const m = THREADED.exec(line);
  if (m) {
    const own = m[3] ? OWN_LOGGER.test(m[3]) : !m[4] || m[4] === 'Minecraft';
    return { msg: unwrapped(line.slice(m[0].length)), level: m[2], thread: m[1], own, server: own && m[1] === 'Server thread' && (m[2] === 'INFO' || m[2] === 'WARN') };
  }
  const p = PAPER.exec(line);
  if (!p) return null;
  return { msg: unwrapped(line.slice(p[0].length)), level: p[1], thread: null, own: true, server: p[1] === 'INFO' || p[1] === 'WARN' };
}

const typed = (msg) => TYPED.test(msg);

// The online names that text holds. A team's prefix and suffix are glued to a name wherever the game prints the display
// name (chat, join, leave, plain list): VIPSteve, [VIP] Bob, Steve Alex.
const namesIn = (text, online) => [...(online?.keys() ?? [])].filter((name) => text.includes(name));
// The one online player a display name can be, or null.
function speaker(display, online) {
  if (online?.has(display)) return display;
  const held = namesIn(display, online);
  return held.length === 1 ? held[0] : null;
}

const chat = (name, text, notSecure) => ({ type: 'chat', name, text: clean(text), secure: !notSecure });

// A split line -> an event: {type: 'join'|'leave'|'chat'|'death'|'advancement'|'command'|'server', name, text, ...}, or
// the two a session only uses on the way to a join, {type: 'uuid', name, uuid} and {type: 'login', name, ip, x, y, z}.
function classify(head, online) {
  if (!head.own || head.level !== 'INFO') return null;
  const { msg } = head;
  const isOn = (name) => !!online?.has(name);
  let m = CHAT.exec(msg);
  if (m) return chat(speaker(m[2], online), m[3], m[1]);
  if ((m = ME.exec(msg))) return chat(m[2], m[3], m[1]);
  if ((m = SAY.exec(msg))) return isOn(m[2]) ? chat(m[2], m[3], m[1]) : null;
  if ((m = UUID_LINE.exec(msg))) return { type: 'uuid', name: m[1], uuid: m[2].toLowerCase() };
  if ((m = LOST.exec(msg))) return { type: 'leave', name: m[1], text: clean(m[2]) };
  if (!head.server) return null;
  if ((m = JOIN.exec(msg))) return { type: 'join', name: m[1], text: '' };
  if ((m = RENAMED.exec(msg))) return { type: 'join', name: m[1], text: '', formerly: m[2] };
  if ((m = LEFT.exec(msg))) return { type: 'leave', name: m[1], text: '' };
  if ((m = LOGIN.exec(msg))) return { type: 'login', name: m[1], ip: maskIp(m[2]), x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) };
  if ((m = COMMAND.exec(msg))) return { type: 'command', name: m[1], text: clean(m[2]) };
  if ((m = ADVANCEMENT.exec(msg))) return isOn(m[1]) ? { type: 'advancement', name: m[1], text: clean(m[2]) } : null;
  if ((m = ADMIN.exec(msg))) return isOn(m[1]) ? { type: 'command', name: m[1], text: clean(m[2]) } : null;
  if (DONE.test(msg)) return { type: 'server', name: null, text: '', state: 'running' };
  if (STOPPING.test(msg)) return { type: 'server', name: null, text: '', state: 'stopping' };
  if (STARTING.test(msg)) return { type: 'server', name: null, text: '', state: 'starting' };
  if ((m = DEATH.exec(msg) ?? DEATH_BY.exec(msg))) return isOn(m[1]) ? { type: 'death', name: m[1], text: clean(msg) } : null;
  return null;
}

// online: the names on the server now (anything with has(name)). Without it no death is believed.
function parseLine(line, online) {
  const head = split(line);
  return head && classify(head, online);
}

module.exports = { parseLine, split, plain, classify, typed, namesIn, maskIp, maskAddresses };
