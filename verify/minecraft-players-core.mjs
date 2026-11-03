// The Players tab's main-process core in plain Node: no Electron, no window, no real server. A fake process object plays
// the server. Log lines, NBT and SNBT here are written from the formats in docs/craft-players-design.md, not captured
// from a real server.
// Checks: the log prefixes of each server kind; deaths and what only looks like one; chat that tries to forge a join, a
// death, a query answer and a command, each line first shown to fool a naive parser; queries (serial, hidden, timed out,
// answered late, ended by a stop or a crash); the output filter on split chunks; binary NBT from a hand-built gzip
// fixture in both item formats, damaged and hostile files; SNBT; the store (batching, torn lines, retention, paging, a
// rebuilt index and a file too large for it, an index cut short at quit, a junction out of the server, the masked IP);
// the server's own files; the IPC core with the real actions.js against a fake process; books written to
// forge server lines; answers by shape; addresses in every stored path; a deleted server; search; and the real launch()
// against a Node stand-in for a JVM on Korean Windows. What a real JVM does is the stand-in's assumption, not proven here.
// Usage: node verify/minecraft-players-core.mjs
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const { parseLine, maskIp, maskAddresses } = require('../main/minecraft/players/logparse.js');
const { parseNbt, readNbt, parseSnbt, snbtEnd, slotOf, detailOf, slotIn } = require('../main/minecraft/players/nbt.js');
const { createStore } = require('../main/minecraft/players/store.js');
const { createSession, matchData, matchList } = require('../main/minecraft/players/session.js');
const { readFlags, readUsercache, readDetail, worldOf } = require('../main/minecraft/players/files.js');
const { createPlayers } = require('../main/minecraft/players/index.js');
const { offlineUuid } = require('../main/minecraft/server-settings.js');
const { parseLine: parseBridge, createTail, refusal, forNewServer } = require('../main/minecraft/players/bridge.js');
const { createGame } = require('./minecraft-players-game.cjs');

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const J = JSON.stringify;
const same = (a, b) => J(a) === J(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await sleep(5); } return false; };
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };

// The session's and the store's timers do not hold a process open, which is right for the app and wrong for this script.
setInterval(() => {}, 1000);
const work = mkdtempSync(path.join(tmpdir(), 'pyide-players-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
let serial = 0;
const freshDir = () => { const d = path.join(work, `s${++serial}`); mkdirSync(d, { recursive: true }); return d; };

const VANILLA = '[12:00:00] [Server thread/INFO]: ';
const PAPER = '[12:00:00 INFO]: ';
const FORGE = '[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: ';
const FABRIC = '[12:00:00] [Server thread/INFO] (Minecraft) ';
const PREFIXES = { vanilla: VANILLA, paper: PAPER, forge: FORGE, fabric: FABRIC };
const STEVE = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const BOB = '853c80ef-3c37-49fd-aa49-938b674adae6';
const ONLINE = new Set(['Steve', 'Bob']);

// ---------- log lines ----------
for (const [kind, p] of Object.entries(PREFIXES)) {
  const ok = (msg, want, label) => {
    const ev = parseLine(p + msg, ONLINE);
    check(ev && Object.entries(want).every(([k, v]) => ev[k] === v), `${kind}: ${label}`);
  };
  ok('Steve joined the game', { type: 'join', name: 'Steve' }, 'join');
  ok('Steve left the game', { type: 'leave', name: 'Steve' }, 'leave');
  ok('Steve lost connection: Timed out', { type: 'leave', name: 'Steve', text: 'Timed out' }, 'lost connection');
  ok('<Bob> hello there', { type: 'chat', name: 'Bob', text: 'hello there', secure: true }, 'chat');
  ok('[Not Secure] <Bob> hello', { type: 'chat', name: 'Bob', text: 'hello', secure: false }, 'chat from an unsigned client');
  ok('Steve was slain by Zombie', { type: 'death', name: 'Steve' }, 'death');
  ok('Steve has made the advancement [Stone Age]', { type: 'advancement', name: 'Steve', text: 'Stone Age' }, 'advancement');
  ok('Steve has reached the goal [Sky is the Limit]', { type: 'advancement', text: 'Sky is the Limit' }, 'goal');
  ok('Steve has completed the challenge [Adventuring Time]', { type: 'advancement', text: 'Adventuring Time' }, 'challenge');
  ok('Steve issued server command: /gamemode creative', { type: 'command', name: 'Steve', text: '/gamemode creative' }, 'issued server command');
  ok('[Steve: Set own game mode to Creative Mode]', { type: 'command', name: 'Steve', text: 'Set own game mode to Creative Mode' }, 'command, plain form');
  ok('Done (3.214s)! For help, type "help"', { type: 'server', state: 'running' }, 'server ready');
  ok('Stopping the server', { type: 'server', state: 'stopping' }, 'server stopping');
  ok(`UUID of player Steve is ${STEVE.toUpperCase()}`, { type: 'uuid', name: 'Steve', uuid: STEVE }, 'uuid line');
}
check(parseLine('[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5')?.uuid === STEVE, 'the uuid line comes from another thread');
check(parseLine('[12:00:00] [Async Chat Thread - #0/INFO]: <Bob> hi')?.type === 'chat', 'chat comes from another thread on Paper');
check(parseLine('[12:00:00 INFO]: Steve joined the game\r')?.type === 'join', 'a CRLF line');
check(parseLine('\x1b[32m[12:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: Steve joined the game\x1b[0m')?.type === 'join', 'colored Forge output');
check(parseLine('[12:00:00] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Steve joined the game')?.type === 'join', 'Forge logger with the full class name');
check(parseLine('[07Jan2026 12:00:00.123] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Steve joined the game')?.type === 'join', 'Forge line with a date');
check(parseLine(`${VANILLA}Bob (formerly known as Steve) joined the game`)?.name === 'Bob', 'a renamed player');
check(parseLine(`${VANILLA}Steve has just earned the achievement [Taking Inventory]`, ONLINE)?.type === 'advancement', 'achievement of old versions');
// Chat shows the display name, which a team's prefix and suffix are glued to.
check(parseLine(`${VANILLA}<VIPSteve> hi`, ONLINE)?.name === 'Steve', 'chat: a team prefix of name characters, and the speaker is the online name inside');
check(parseLine(`${VANILLA}<Steve Alex> hi`, ONLINE)?.name === 'Steve', 'chat: a suffix that looks like a name is not the speaker');
check(parseLine(`${VANILLA}<Steve Bob> hi`, ONLINE)?.type === 'chat' && parseLine(`${VANILLA}<Steve Bob> hi`, ONLINE).name === null, 'chat: a display name holding two online names is nobody\'s');
const login = parseLine(`${VANILLA}Steve[/1.2.3.4:51234] logged in with entity id 123 at (10.5, 64.0, -3.25)`);
check(login?.type === 'login' && login.ip === '1.2.*.*' && login.x === 10.5 && login.z === -3.25 && !J(login).includes('1.2.3.4'), 'login: the IP is masked before anything sees it');
check(parseLine(`${PAPER}Steve[/1.2.3.4:51234] logged in with entity id 123 at ([world]10.5, 64.0, -3.25)`)?.y === 64, 'login on Paper names the world');
check(!J(parseLine(`${VANILLA}Steve[/[2001:db8:1:2::3]:51234] logged in with entity id 1 at (1.0, 2.0, 3.0)`)).includes('1:2'), 'an IPv6 address is masked');
check(parseLine(`${VANILLA}Steve[<ip address withheld>] logged in with entity id 1 at (1.0, 2.0, 3.0)`)?.ip === null, 'log-ips=false: no address, no guess');
check(parseLine(`${VANILLA}Steve[local:E:1234abcd] logged in with entity id 1 at (1.0, 2.0, 3.0)`)?.ip === null, 'a local connection has no address');
check(maskIp('/8.8.4.4:25565') === '8.8.*.*' && maskIp('/[::ffff:8.8.4.4]:1') === '8.8.*.*' && maskIp('junk') === null, 'maskIp keeps two parts or nothing');

check(parseLine(`${VANILLA}com.mojang.authlib.GameProfile@1a2b3c[id=<null>,name=Steve,properties={},legacy=false] (/1.2.3.4:1234) lost connection: Disconnected`) === null, 'a failed login with an IP is no leave');
check(parseLine(`${VANILLA}Steve (/1.2.3.4:51234) lost connection: Disconnected`) === null, 'a disconnect during login is no leave');

// Every head of the game's death messages, en_us.json's death.* (older wordings at the end).
const DEATHS = ['was squashed by a falling anvil', 'was shot by Skeleton', 'was shot by Bob using [Bow]', 'was killed by [Intentional Game Design]', 'was pricked to death',
  'walked into a cactus while trying to escape Zombie', 'was squished too much', 'was squashed by Bob', "was roasted in dragon's breath", 'drowned',
  'drowned while trying to escape Zombie', 'died from dehydration', 'was killed by even more magic', 'blew up', 'was blown up by Creeper', 'hit the ground too hard',
  'was squashed by a falling block', 'was skewered by a falling stalactite', 'was fireballed by Ghast', 'went off with a bang', 'experienced kinetic energy', 'froze to death',
  'was frozen to death by Bob', 'died', 'died because of Bob', 'was killed', 'discovered the floor was lava', 'walked into the danger zone due to Bob', 'went up in flames',
  'walked into fire while fighting Bob', 'suffocated in a wall', 'was killed by Witch using magic', 'tried to swim in lava', 'was struck by lightning',
  'was smashed by Bob', 'was killed by magic', 'was slain by Bob using [Excalibur]', 'burned to death', 'was burned to a crisp while fighting Bob', 'fell out of the world',
  "didn't want to live in the same world as Bob", 'left the confines of this world', 'was obliterated by a sonically-charged shriek', 'was impaled on a stalagmite',
  'starved to death', 'was stung to death', 'was poked to death by a sweet berry bush', 'was killed while trying to hurt Bob', 'was pummeled by Bob', 'was impaled by Drowned',
  'withered away', 'was shot by a skull from Wither', 'fell from a high place', 'fell off a ladder', 'fell while climbing', 'fell off scaffolding', 'fell off some twisting vines',
  'fell off some vines', 'fell off some weeping vines', 'was doomed to fall', 'fell too far and was finished by Zombie', 'got finished off by Bob', 'was knocked into the void by Bob', 'was burnt to a crisp whilst fighting Bob',
  'fell out of water', 'died because not just the floor is lava', 'was speared by Bob using [Spear]', 'was slain by Wind Charge'];
check(DEATHS.every((d) => parseLine(`${VANILLA}Steve ${d}`, ONLINE)?.type === 'death'), `${DEATHS.length} death messages are deaths`);
check(DEATHS.every((d) => parseLine(`${VANILLA}Alex ${d}`, ONLINE) === null), 'the same lines about someone not online are nothing');
check(parseLine(`${VANILLA}Steve fell from a high place`) === null, 'without the online list no death is believed');
const NOT_DEATHS = ['moved too quickly! 1.0,2.0,3.0', 'moved wrongly!', 'was kicked for floating too long!', 'left the game', 'lost connection: Timed out', 'has the following entity data: 1',
  'tried to command an entity', 'was here', 'fell'];
check(NOT_DEATHS.every((d) => parseLine(`${VANILLA}Steve ${d}`, ONLINE)?.type !== 'death'), 'server lines that name a player but are no deaths');
check(parseLine(`${VANILLA}Named entity Wolf['Steve fell from a high place'/1, l='ServerLevel[world]', x=1.0, y=2.0, z=3.0] died: Steve fell from a high place`, ONLINE) === null, 'a named pet that died is no player death');
check(parseLine(`${VANILLA}Steve was slain by Bob using [Steve joined the game]`, ONLINE)?.type === 'death', 'a named item in a death stays one death');
{
  // The one wording that starts with the killer.
  const lava = parseLine(`${VANILLA}Sulfur Cube showed Steve that not just the floor is lava`, ONLINE);
  check(lava?.type === 'death' && lava.name === 'Steve', 'a death that starts with the killer belongs to the victim');
  check(parseLine(`${VANILLA}Bob showed Steve that not just the floor is lava using [Sword]`, ONLINE)?.name === 'Steve', 'and may name a weapon');
  check(parseLine(`${VANILLA}Bob showed Alex that not just the floor is lava`, ONLINE) === null, 'about someone not online it is nothing');
  check(parseLine(`${VANILLA}Named entity Wolf['Q showed Steve that not just the floor is lava using x'/1, l='ServerLevel[world]', x=1.0, y=2.0, z=3.0] died: Wolf was slain by Bob`, ONLINE) === null, 'a pet named after it kills nobody');
}
// 26.3 logs what the console is told behind `System chat: `, which is its broadcasts and the answers to its commands.
const SYS = `${VANILLA}System chat: `;
for (const [p, label] of [[SYS, 'vanilla'], [`${PAPER}System chat: `, 'paper'], [`${FABRIC}System chat: `, 'fabric']]) {
  for (const [msg, want] of [['Steve joined the game', { type: 'join', name: 'Steve' }], ['Steve left the game', { type: 'leave', name: 'Steve' }], ['Steve fell from a high place', { type: 'death', name: 'Steve' }],
    ['Steve has made the advancement [Stone Age]', { type: 'advancement', text: 'Stone Age' }], ['[Steve: Set own game mode to Creative Mode]', { type: 'command', text: 'Set own game mode to Creative Mode' }]]) {
    const ev = parseLine(p + msg, ONLINE);
    check(ev && Object.entries(want).every(([k, v]) => ev[k] === v), `${label} 26.3: ${msg}`);
  }
}
check(DEATHS.every((d) => parseLine(`${SYS}Steve ${d}`, ONLINE)?.type === 'death'), '26.3: every death message');
for (const line of [`${VANILLA}<Bob> System chat: Steve joined the game`, `${VANILLA}[Not Secure] <Bob> System chat: Steve joined the game`, `${VANILLA}* Bob System chat: Steve joined the game`]) {
  check(parseLine(line, ONLINE)?.type === 'chat', `chat that starts like a system line stays chat: ${line.slice(VANILLA.length)}`);
}
for (const line of ['[12:00:00] [Async Chat Thread - #0/INFO]: System chat: Steve joined the game', '[12:00:00] [Server thread/INFO] [chatmod/]: System chat: Steve joined the game', `${PAPER}[Essentials] System chat: Steve joined the game`, 'System chat: Steve joined the game']) {
  check(parseLine(line, ONLINE) === null, `the same words from elsewhere are nothing: ${line.slice(0, 44)}`);
}

// ---------- forged lines: each fools a naive parser, none fools this one ----------
const naive = (line) => {
  let m;
  if ((m = /(\w+) joined the game/.exec(line))) return { type: 'join', name: m[1] };
  if ((m = /(\w+) left the game/.exec(line))) return { type: 'leave', name: m[1] };
  if ((m = /(\w+) issued server command: (.*)/.exec(line))) return { type: 'command', name: m[1] };
  if ((m = /(\w+) has made the advancement/.exec(line))) return { type: 'advancement', name: m[1] };
  if ((m = /UUID of player (\w+) is/.exec(line))) return { type: 'uuid', name: m[1] };
  if ((m = /(\w+)\[.*\] logged in with entity id/.exec(line))) return { type: 'login', name: m[1] };
  if (/Stopping the server/.test(line)) return { type: 'server' };
  if ((m = /(\w+) (?:fell|was slain|drowned|blew up)/.exec(line))) return { type: 'death', name: m[1] };
  return null;
};
const FORGED = [['Steve joined the game', 'join'], ['Steve left the game', 'leave'], ['Steve fell from a high place', 'death'], ['Steve was slain by Bob', 'death'],
  ['Steve issued server command: /op Bob', 'command'], ['Steve has made the advancement [Cheater]', 'advancement'],
  [`UUID of player Steve is ${BOB}`, 'uuid'], ['Steve[/9.9.9.9:1] logged in with entity id 1 at (1.0, 2.0, 3.0)', 'login'], ['Stopping the server', 'server'],
  ['[12:00:00] [Server thread/INFO]: Steve joined the game', 'join'], ['[12:00:00 INFO]: Steve fell from a high place', 'death']];
const SHAPES = [['chat', (t) => `<Bob> ${t}`], ['unsigned chat', (t) => `[Not Secure] <Bob> ${t}`], ['chat with a team prefix', (t) => `<[VIP] Bob> ${t}`]];
for (const [kind, p] of Object.entries(PREFIXES)) {
  for (const [shape, wrap] of SHAPES) {
    for (const [text, type] of FORGED) {
      const line = p + wrap(text);
      const ev = parseLine(line, ONLINE);
      check(naive(line)?.type === type && ev?.type === 'chat' && ev.name === 'Bob', `${kind} ${shape} saying "${text.slice(0, 34)}" is chat`);
    }
  }
}
for (const [text, type] of FORGED.slice(0, 6)) {
  const me = parseLine(`${VANILLA}* Bob ${text}`, ONLINE);
  check(naive(`${VANILLA}* Bob ${text}`)?.type === type && me?.type === 'chat' && me.name === 'Bob', `/me saying "${text.slice(0, 30)}" is chat`);
  const say = parseLine(`${VANILLA}[Bob] ${text}`, ONLINE);
  check(naive(`${VANILLA}[Bob] ${text}`)?.type === type && say?.type === 'chat' && say.name === 'Bob', `/say saying "${text.slice(0, 30)}" is chat`);
  check(parseLine(`${VANILLA}[Server] ${text}`, ONLINE) === null, `the console's say "${text.slice(0, 30)}" is nothing`);
  // A mod or a plugin repeating text at the start of its own line, or a player's text whispered on.
  check(parseLine(`[12:00:00] [Server thread/INFO] [chatmod/]: ${text}`, ONLINE) === null, `a mod's logger saying "${text.slice(0, 30)}" is nothing`);
  check(parseLine(`[12:00:00] [Server thread/INFO] (SomeMod) ${text}`, ONLINE) === null, `a Fabric mod's logger saying "${text.slice(0, 30)}" is nothing`);
  check(parseLine(`[12:00:00 INFO]: [Essentials] ${text}`, ONLINE) === null, `a plugin saying "${text.slice(0, 30)}" is nothing`);
  check(parseLine(`${VANILLA}Bob whispers to Alex: ${text}`, ONLINE) === null, `a whisper of "${text.slice(0, 30)}" is nothing`);
}
check(parseLine('Steve joined the game', ONLINE) === null, 'no prefix, no event');
check(parseLine(`[Server thread/INFO]: Steve joined the game`, ONLINE) === null, 'half a prefix, no event');
check(parseLine('[12:00:00] [Async Chat Thread - #0/INFO]: Steve joined the game', ONLINE) === null, 'a join off the server thread is nothing');
check(parseLine(`${VANILLA}<Bob> a\r[12:00:00] [Server thread/INFO]: Steve joined the game`, ONLINE)?.type === 'chat', 'a carriage return in chat does not start a line');
check(!parseLine(`${VANILLA}<Bob> ${'x'.repeat(100000)}`, ONLINE).text.includes('x'.repeat(513)), 'stored text is capped');
check(!/[\x00-\x1f§]/.test(parseLine(`${VANILLA}<Bob> a\x07§cb\tc`, ONLINE).text), 'control characters and format codes do not survive');

// ---------- binary NBT, built by hand ----------
const str = (s) => { const b = Buffer.from(s, 'utf8'); const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const be = (fn, size, v) => { const b = Buffer.alloc(size); b[fn](v); return b; };
const named = (type, name, body) => Buffer.concat([Buffer.from([type]), str(name), body]);
const T = {
  byte: (n, v) => named(1, n, be('writeInt8', 1, v)), short: (n, v) => named(2, n, be('writeInt16BE', 2, v)), int: (n, v) => named(3, n, be('writeInt32BE', 4, v)),
  long: (n, v) => named(4, n, be('writeBigInt64BE', 8, v)), float: (n, v) => named(5, n, be('writeFloatBE', 4, v)), double: (n, v) => named(6, n, be('writeDoubleBE', 8, v)),
  string: (n, v) => named(8, n, str(v)), compound: (n, ...kids) => named(10, n, Buffer.concat([...kids, Buffer.from([0])])),
  list: (n, type, items) => named(9, n, Buffer.concat([Buffer.from([type]), be('writeInt32BE', 4, items.length), ...items])),
  ints: (n, v) => named(11, n, Buffer.concat([be('writeInt32BE', 4, v.length), ...v.map((x) => be('writeInt32BE', 4, x))])),
};
const body = (...kids) => Buffer.concat([...kids, Buffer.from([0])]);
const oldItem = (slot, id, count, ...tag) => body(T.byte('Slot', slot), T.string('id', id), T.byte('Count', count), ...(tag.length ? [T.compound('tag', ...tag)] : []));
const newItem = (slot, id, count, ...comps) => body(T.byte('Slot', slot), T.string('id', id), T.int('count', count), ...(comps.length ? [T.compound('components', ...comps)] : []));
const common = [T.list('Pos', 6, [1.5, 64, -3.25].map((v) => be('writeDoubleBE', 8, v))), T.float('Health', 18.5), T.int('foodLevel', 17), T.int('XpLevel', 30),
  T.int('playerGameType', 1), T.int('SelectedItemSlot', 4), T.ints('UUID', [1, 2, 3, 4]), T.long('LastPlayed', 1700000000000n), T.long('Huge', 9007199254740993n)];
const oldPlayer = T.compound('', ...common, T.string('Dimension', 'minecraft:overworld'), T.list('Inventory', 10, [
  oldItem(0, 'minecraft:diamond_sword', 1, T.int('Damage', 7), T.list('Enchantments', 10, [body(T.string('id', 'minecraft:sharpness'), T.short('lvl', 5))]),
    T.compound('display', T.string('Name', '{"text":"Excalibur"}'))),
  oldItem(35, 'minecraft:stone', 64), oldItem(103, 'minecraft:iron_helmet', 1), oldItem(-106, 'minecraft:shield', 1),
]), T.list('EnderItems', 10, [oldItem(3, 'minecraft:enchanted_book', 1, T.list('StoredEnchantments', 10, [body(T.string('id', 'minecraft:mending'), T.short('lvl', 1))]))]));
const newPlayer = T.compound('', ...common, T.string('Dimension', 'minecraft:the_nether'), T.list('Inventory', 10, [
  newItem(0, 'minecraft:diamond_sword', 1, T.int('minecraft:damage', 7), T.compound('minecraft:enchantments', T.compound('levels', T.int('minecraft:sharpness', 5))),
    T.string('minecraft:custom_name', '{"text":"Excalibur"}')),
  newItem(35, 'minecraft:stone', 64), newItem(103, 'minecraft:iron_helmet', 1),
]));
// 1.21.5: armor and the offhand in `equipment`, enchantments flat, the custom name a compound.
const equipped = T.compound('', ...common, T.string('Dimension', 'minecraft:the_end'), T.list('Inventory', 10, [
  newItem(1, 'minecraft:diamond_sword', 1, T.compound('minecraft:enchantments', T.int('minecraft:sharpness', 5)), T.compound('minecraft:custom_name', T.string('text', 'Excalibur'))),
]), T.compound('equipment', T.compound('head', T.string('id', 'minecraft:iron_helmet'), T.int('count', 1)), T.compound('offhand', T.string('id', 'minecraft:shield'), T.int('count', 1))));

const sword = (s) => s.id === 'minecraft:diamond_sword' && s.name === 'Excalibur' && same(s.enchantments, [{ id: 'minecraft:sharpness', level: 5 }]);
for (const [label, buf] of [['old format', oldPlayer], ['new format', newPlayer]]) {
  const root = await readNbt(zlib.gzipSync(buf));
  const d = detailOf(root);
  check(d.health === 18.5 && d.food === 17 && d.xpLevel === 30 && d.gamemode === 'creative' && d.selected === 4 && d.source === 'file', `${label}: player state`);
  check(d.pos.x === 1.5 && d.pos.y === 64 && d.pos.z === -3.25, `${label}: position`);
  check(d.inventory.length === 2 && sword(d.inventory[0]) && d.inventory[0].damage === 7 && d.inventory[0].slot === 0, `${label}: an enchanted, named, damaged sword`);
  check(d.inventory[1].slot === 35 && d.inventory[1].count === 64 && d.inventory[1].damage === null && d.inventory[1].name === null, `${label}: a plain stack`);
  check(d.armor.length === 1 && d.armor[0].slot === 103 && d.armor[0].id === 'minecraft:iron_helmet', `${label}: armor`);
  check(root.LastPlayed === 1700000000000 && root.Huge === '9007199254740993' && same(root.UUID, [1, 2, 3, 4]), `${label}: longs stay exact, int arrays are read`);
  check(!!J(d.inventory[0].raw), `${label}: raw is JSON safe`);
}
{
  const d = detailOf(await readNbt(zlib.gzipSync(oldPlayer)));
  check(d.offhand?.slot === -106 && d.offhand.id === 'minecraft:shield', 'old format: the offhand is slot -106');
  check(d.ender[0].slot === 3 && same(d.ender[0].enchantments, [{ id: 'minecraft:mending', level: 1 }]), 'stored enchantments of a book in the ender chest');
  check(d.pos.dimension === 'minecraft:overworld', 'dimension');
  const e = detailOf(await readNbt(zlib.gzipSync(equipped)));
  check(e.offhand?.slot === -106 && e.armor[0]?.slot === 103 && e.armor[0].count === 1 && sword(e.inventory[0]) && e.pos.dimension === 'minecraft:the_end', '1.21.5: equipment, flat enchantments, a compound name');
  check(detailOf({ Pos: [1, 2, 3], Dimension: -1 }).pos.dimension === 'minecraft:the_nether', 'an old numeric dimension');
  check(slotOf(parseSnbt('{id: "minecraft:stick", Count: 1b, tag: {ench: [{id: 16s, lvl: 5s}], display: {Name: "§cPlain"}}}'), 7).enchantments[0].id === '16', 'numeric enchantment ids and plain names of 1.12');
  check(slotOf(parseSnbt('{id: "minecraft:air", count: 1}')) === null, 'air is no item');
  check(slotOf(parseSnbt('{id: 5}')) === null, 'an id that is not text is no item');
}
{
  const java = Buffer.from([0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0x41]); // NUL, one emoji as a surrogate pair, A
  const n = Buffer.alloc(2);
  n.writeUInt16BE(java.length);
  const root = parseNbt(T.compound('', named(8, 'a', Buffer.concat([n, java]))));
  check(root.a === '\u0000\u{1F600}A', "Java's modified UTF-8");
  const evil = parseNbt(T.compound('', T.compound('__proto__', T.byte('polluted', 1))));
  check(({}).polluted === undefined && evil.polluted === undefined && Object.getPrototypeOf(evil) === null, 'a key named __proto__ is only a key');
}
const damaged = async (buf, label, opts) => {
  const err = await errOf(() => readNbt(buf, opts));
  check(err?.code === 'damaged' && /damaged/.test(err.message), `${label}: ${err?.message ?? 'no error'}`);
};
const gz = zlib.gzipSync(oldPlayer);
await damaged(gz.subarray(0, gz.length - 12), 'truncated gzip');
await damaged(Buffer.concat([gz.subarray(0, 40), Buffer.alloc(40, 0xff), gz.subarray(80)]), 'garbage inside gzip');
await damaged(Buffer.alloc(0), 'an empty file');
await damaged(Buffer.from('not nbt at all'), 'a file that is not NBT');
await damaged(zlib.gzipSync(oldPlayer.subarray(0, oldPlayer.length - 20)), 'NBT that ends early');
await damaged(zlib.gzipSync(Buffer.concat([oldPlayer, Buffer.from([0])])), 'data after the end');
await damaged(zlib.gzipSync(T.compound('', Buffer.from([99]), str('x'))), 'an unknown tag');
await damaged(zlib.gzipSync(T.compound('', named(9, 'l', Buffer.concat([Buffer.from([10]), be('writeInt32BE', 4, 0x7fffffff)])))), 'a list claiming two billion entries');
await damaged(zlib.gzipSync(T.compound('', named(9, 'l', Buffer.concat([Buffer.from([1]), be('writeInt32BE', 4, -1)])))), 'a negative list length');
await damaged(zlib.gzipSync(T.compound('', named(11, 'a', be('writeInt32BE', 4, 0x7fffffff)))), 'an array claiming two billion entries');
await damaged(zlib.gzipSync(T.compound('', named(9, 'l', Buffer.concat([Buffer.from([0]), be('writeInt32BE', 4, 5)])))), 'a list of nothing with a length');
{
  let deep = Buffer.from([0]);
  for (let i = 0; i < 2000; i++) deep = Buffer.concat([Buffer.from([10, 0, 0]), deep, Buffer.from([0])]);
  await damaged(zlib.gzipSync(Buffer.concat([Buffer.from([10, 0, 0]), deep])), 'compounds nested 2000 deep');
  await damaged(zlib.gzipSync(Buffer.concat([Buffer.from([10, 0, 0]), Buffer.from([9, 0, 1, 0x6c, 1]), be('writeInt32BE', 4, 1000000), Buffer.alloc(1000000), Buffer.from([0])])), 'more values than allowed', { maxNodes: 1000 });
  const bomb = await errOf(() => readNbt(zlib.gzipSync(Buffer.alloc(32 << 20))));
  check(/too large/.test(bomb?.message), 'a gzip bomb stops at the size limit');
}

// ---------- SNBT ----------
{
  const v = parseSnbt(`{Pos: [1.5d, -2.0d, 3.0E2d], Health: 20.0f, b: 1b, s: 300s, i: 7, l: 9007199254740993L, f: 1.5, ba: [B; 1b, 2b], ia: [I; 1, -2], la: [L; 1L], e: [], ec: {},
    "quoted key": "a\\"b\\\\c", single: 'it"s', id: minecraft:stone, t: true, neg: -5, n: "\\n\\u0041"}`);
  check(same(v.Pos, [1.5, -2, 300]) && v.Health === 20 && v.b === 1 && v.s === 300 && v.i === 7 && v.l === '9007199254740993' && v.f === 1.5, 'SNBT numbers with their suffixes');
  check(same(v.ba, [1, 2]) && same(v.ia, [1, -2]) && same(v.la, [1]) && same(v.e, []) && same(Object.keys(v.ec), []), 'SNBT typed arrays and empties');
  check(v['quoted key'] === 'a"b\\c' && v.single === 'it"s' && v.id === 'minecraft:stone' && v.t === 1 && v.neg === -5 && v.n === '\nA', 'SNBT strings, quoted and bare');
  const old = parseSnbt('{Slot: 0b, id: "minecraft:diamond_sword", Count: 1b, tag: {Damage: 7, Enchantments: [{id: "minecraft:sharpness", lvl: 5s}], display: {Name: \'{"text":"Excalibur"}\'}}}');
  const fresh = parseSnbt('{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:damage": 7, "minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}, "minecraft:custom_name": \'{"text":"Excalibur"}\'}}');
  for (const [label, item] of [['old', old], ['new', fresh]]) check(sword(slotOf(item)) && slotOf(item).damage === 7 && slotOf(item).slot === 0, `SNBT item, ${label} format`);
  check(Object.getPrototypeOf(parseSnbt('{"__proto__": {x: 1b}}')) === null && ({}).x === undefined, 'SNBT: a key named __proto__ is only a key');
  for (const [text, label] of [['{a: 1', 'an unended compound'], ['[1, 2', 'an unended list'], ['{a 1}', 'no colon'], ['"abc', 'an unended text'], ['{a: 1} x', 'more after the value'], ['', 'nothing'],
    ['[1, ]', 'a trailing comma'], [`${'['.repeat(5000)}${']'.repeat(5000)}`, 'lists nested 5000 deep'], [`${'{a:'.repeat(5000)}1${'}'.repeat(5000)}`, 'compounds nested 5000 deep'], ['"\\u12"', 'a short escape']]) {
    const err = await errOf(() => parseSnbt(text));
    check(err?.code === 'damaged', `SNBT refuses ${label}`);
  }
  check((await errOf(() => parseSnbt('x'.repeat(100), { maxLength: 10 })))?.code === 'damaged', 'SNBT refuses text over the limit');
  check((await errOf(() => parseSnbt(`[${'1,'.repeat(50)}1]`, { maxNodes: 10 })))?.code === 'damaged', 'SNBT refuses more values than allowed');
}

// ---------- the store ----------
{
  const dir = freshDir();
  const store = createStore(dir, { flushMs: 20 });
  await store.open();
  check(readFileSync(path.join(dir, '.nano', '.gitignore'), 'utf8').trim() === '*', 'the folder keeps itself out of git');
  const file = path.join(store.folder, `${STEVE}.jsonl`);
  store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'one' });
  check(!existsSync(file), 'add() does not touch the disk');
  check(await waitFor(() => existsSync(file)), 'the queue is written in a batch');
  await store.flush();
  const before = statSync(file).size;
  for (let i = 0; i < 2000; i++) store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: `n${i}` });
  check(statSync(file).size === before, 'two thousand lines queued without a write');
  const { events, more } = await store.timeline(STEVE, { limit: 10 });
  check(events.length === 10 && more && events[0].text === 'n1999', 'timeline: newest first, flushed before reading');
  const seen = new Set();
  let cursor;
  for (let n = 0; n < 500; n++) {
    const page = await store.timeline(STEVE, { limit: 300, before: cursor });
    for (const e of page.events) seen.add(e.text);
    cursor = page.events.at(-1)?.t;
    if (!page.more) break;
  }
  check(seen.size === 2001, `paging with before loses nothing (${seen.size})`);
  store.add({ type: 'death', name: 'Steve', uuid: STEVE, text: 'Steve fell from a high place' });
  store.add({ type: 'chat', name: 'Bob', uuid: BOB, text: 'Hello Steve' });
  check((await store.timeline(STEVE, { types: ['death'] })).events.length === 1, 'timeline by type');
  check((await store.timeline(STEVE, { q: 'N199' })).events.length === 11, 'timeline by text, any case');
  check((await store.search({ q: 'steve', limit: 2 })).length === 2, 'search across players, limited');
  check((await store.search({ q: 'hello' }))[0]?.name === 'Bob', 'search finds the other player');
  check((await store.search({ types: ['death'] })).length === 1, 'search by type');
  check(same(await store.timeline('../../evil', {}), { events: [], more: false }), 'timeline refuses a path for a uuid');
  store.add({ type: 'chat', name: 'x', uuid: '../../evil', text: 'x' });
  await store.flush();
  check(!existsSync(path.join(dir, 'evil.jsonl')) && !existsSync(path.join(store.folder, '..', '..', '..', 'evil.jsonl')), 'an event with a bad uuid writes no file');
  store.admin({ action: { type: 'kick', target: 'Bob' }, commands: ['kick Bob'], ok: true, text: 'Kicked Bob' });
  store.admin({ action: { type: 'whisper', target: 'Bob', text: 'x'.repeat(100000) }, commands: [], ok: false, text: '' });
  const log = await store.adminLog({ limit: 10 });
  check(log.length === 2 && log[1].commands[0] === 'kick Bob' && log[1].ok === true, 'the admin log');
  check(J(log[0]).length < 2000, 'a huge action is not stored whole');
  check((await store.adminLog({ limit: 1 })).length === 1, 'admin log limit');

  store.touch(STEVE, 'Steve', { playTimeMs: 1000 });
  store.touch(STEVE, 'Steve2', { playTimeMs: 500 });
  await store.flush();
  const again = createStore(dir);
  check(again.known()[STEVE]?.playTimeMs === 1500 && again.known()[STEVE].name === 'Steve2' && again.uuidOf('Steve2') === STEVE, 'the index survives a new store and follows a rename');
  writeFileSync(path.join(store.folder, 'index.json'), '{"players": {"torn');
  const rebuilt = createStore(dir);
  check(rebuilt.known()[STEVE]?.name === 'Steve' && rebuilt.known()[BOB]?.name === 'Bob', 'a damaged index is rebuilt from the player files');
  rmSync(store.folder, { recursive: true, force: true });
  await rebuilt.open();
  check(Object.keys(rebuilt.known()).length === 0, 'a server made again in the same folder starts with an empty roster');
}
{
  // A crash: a torn last line, then the next session.
  const dir = freshDir();
  const store = createStore(dir);
  await store.open();
  store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'whole' });
  await store.flush();
  const file = path.join(store.folder, `${STEVE}.jsonl`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"t":"2026-10-30T00:00:00.000Z","type":"chat","na`);
  check((await store.timeline(STEVE)).events.length === 1, 'a reader skips the torn line');
  const next = createStore(dir, { flushMs: 5 });
  await next.open();
  next.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'after' });
  await next.flush();
  const { events } = await next.timeline(STEVE);
  check(same(events.map((e) => e.text), ['after', 'whole']), 'the next session repairs the file before it appends');
  check(readFileSync(file, 'utf8').split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'no line is broken afterwards');
}
{
  const dir = freshDir();
  const folder = path.join(dir, '.nano', 'players');
  mkdirSync(folder, { recursive: true });
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const line = (days, text) => J({ t: at(days), type: 'chat', name: 'Steve', uuid: STEVE, text });
  writeFileSync(path.join(folder, `${STEVE}.jsonl`), `${[line(40, 'old'), line(31, 'old2'), line(29, 'recent'), line(1, 'new')].join('\n')}\n`);
  writeFileSync(path.join(folder, `${BOB}.jsonl`), `${line(35, 'gone')}\n`);
  writeFileSync(path.join(folder, 'admin.jsonl'), `${J({ t: at(50), action: {}, commands: [], ok: true, text: 'old' })}\n${J({ t: at(2), action: {}, commands: [], ok: true, text: 'new' })}\n`);
  const store = createStore(dir);
  await store.open();
  check(same((await store.timeline(STEVE)).events.map((e) => e.text), ['new', 'recent']), 'retention: events older than 30 days go at session start');
  check(!existsSync(path.join(folder, `${BOB}.jsonl`)), 'a file with nothing left goes');
  check(same((await store.adminLog()).map((e) => e.text), ['new']), 'the admin log is pruned too');
  const short = createStore(dir, { retentionDays: 10 });
  await short.open();
  check(same((await short.timeline(STEVE)).events.map((e) => e.text), ['new']), 'retention is an option');
}
{
  // A disk that refuses: nothing thrown into the server's output path, and the lines wait.
  const dir = freshDir();
  mkdirSync(path.join(dir, '.nano'), { recursive: true });
  writeFileSync(path.join(dir, '.nano', 'players'), 'a file where the folder should be');
  const logged = [];
  const store = createStore(dir, { log: (t) => logged.push(t) });
  await store.open();
  store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'kept' });
  await store.flush();
  check(logged.length > 0, 'a disk error is logged, not thrown');
  rmSync(path.join(dir, '.nano', 'players'));
  await store.flush();
  check((await store.timeline(STEVE)).events[0]?.text === 'kept', 'lines the disk refused are written once it accepts them');
}
{
  // A junction in place of .nano or .nano/players must not lead the store out of the server folder.
  const old = J({ t: new Date(Date.now() - 40 * 86400000).toISOString(), type: 'chat', name: 'Steve', uuid: STEVE, text: 'old' });
  for (const at of ['.nano', path.join('.nano', 'players')]) {
    const dir = freshDir();
    const outside = freshDir();
    const files = at === '.nano' ? path.join(outside, 'players') : outside;
    mkdirSync(files, { recursive: true });
    writeFileSync(path.join(files, `${STEVE}.jsonl`), `${old}\n`);
    writeFileSync(path.join(files, 'admin.jsonl'), `${old}\n`);
    mkdirSync(path.dirname(path.join(dir, at)), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, at), 'junction');
    const logs = [];
    const store = createStore(dir, { flushMs: 5, log: (l) => logs.push(l) });
    await store.open();
    store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'new' });
    store.touch(STEVE, 'Steve');
    store.admin({ action: { type: 'kick' }, commands: [], ok: true, text: '' });
    await store.flush();
    store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'at quit' });
    store.touch(BOB, 'Bob');
    store.flushSync();
    const left = readdirSync(files).sort();
    check(same(left, [`${STEVE}.jsonl`, 'admin.jsonl']) && readFileSync(path.join(files, `${STEVE}.jsonl`), 'utf8') === `${old}\n`
      && readFileSync(path.join(files, 'admin.jsonl'), 'utf8') === `${old}\n` && !existsSync(path.join(outside, '.gitignore')),
    `a junction at ${at}: nothing outside the server is pruned, written or removed (${left})`);
    check(logs.some((l) => l.includes('out of the server folder')), `a junction at ${at}: the log says why (${logs.join('; ')})`);
    check((await store.timeline(STEVE)).events.length === 0, `a junction at ${at}: nothing is read through it either`);
  }
}
{
  // At quit the index is written whole or not at all.
  const dir = freshDir();
  const store = createStore(dir, { flushMs: 100000 });
  await store.open();
  store.touch(STEVE, 'Steve');
  store.flushSync();
  const indexFile = path.join(store.folder, 'index.json');
  const whole = readFileSync(indexFile, 'utf8');
  store.touch(BOB, 'Bob');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...more) => { realWrite(file, String(data).slice(0, 10), ...more); throw Object.assign(new Error('the disk is full'), { code: 'ENOSPC' }); };
  try { store.flushSync(); } finally { fs.writeFileSync = realWrite; }
  check(readFileSync(indexFile, 'utf8') === whole, 'a write cut short at quit leaves the last whole index');
  store.flushSync();
  check(JSON.parse(readFileSync(indexFile, 'utf8')).players[BOB]?.name === 'Bob', 'and the next write puts in what it missed');
}
{
  // A rebuild of the index reads every player file at once: one too large to read so is left out, and said so.
  const dir = freshDir();
  const folder = path.join(dir, '.nano', 'players');
  mkdirSync(folder, { recursive: true });
  const joinLine = (name, uuid) => `${J({ t: new Date().toISOString(), type: 'join', name, uuid, text: '' })}\n`;
  writeFileSync(path.join(folder, `${STEVE}.jsonl`), joinLine('Steve', STEVE));
  const big = path.join(folder, `${BOB}.jsonl`);
  writeFileSync(big, joinLine('Bob', BOB));
  fs.truncateSync(big, 40 << 20);
  const logs = [];
  const known = createStore(dir, { log: (l) => logs.push(l) }).known();
  check(known[STEVE]?.name === 'Steve' && !known[BOB] && logs.some((l) => l.includes(`${BOB}.jsonl`)), `a player file too large to rebuild from is skipped with a log line (${logs.join('; ')})`);
  rmSync(big);
}

// ---------- a session against a fake process ----------
class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.answer = null;
    this.stdin = { write: (s) => { this.written.push(s); this.answer?.(s.trim()); return true; } };
  }
}
const fakeStore = (dir) => createStore(dir, { flushMs: 10 });
function running(opts = {}) {
  const dir = freshDir();
  const store = fakeStore(dir);
  const pings = [];
  const session = createSession({ version: '1.21.1', store, notify: (k) => pings.push(k), pingMs: 1, pollMs: 100000, listMs: 100000, ...opts });
  const proc = new FakeProcess();
  session.attach(proc);
  const say = (line) => session.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (3.2s)! For help, type "help"`);
  return { dir, store, session, proc, say, pings };
}
const join = (t, name = 'Steve', uuid = STEVE, ip = '1.2.3.4') => {
  t.say(`[12:00:00] [User Authenticator #1/INFO]: UUID of player ${name} is ${uuid}`);
  t.say(`${VANILLA}${name}[/${ip}:51234] logged in with entity id 1 at (1.5, 64.0, 2.5)`);
  t.say(`${VANILLA}${name} joined the game`);
};
const pos = (name, x = 1) => `${VANILLA}${name} has the following entity data: [${x}.5d, 64.0d, 2.5d]`;

{
  const t = running();
  check(t.session.state === 'running', 'the Done line makes the server running');
  join(t);
  check(t.session.players().length === 1 && t.session.players()[0].uuid === STEVE && t.session.players()[0].pos.x === 1.5, 'join: uuid and position from the server lines');
  check(await waitFor(() => t.pings.includes('roster')), 'a join pings the window');
  t.say(`${VANILLA}<Steve> hi`);
  t.say(`${VANILLA}[Not Secure] <Steve> hi again`);
  t.say(`${VANILLA}Steve fell from a high place`);
  t.say(`${VANILLA}Steve has made the advancement [Stone Age]`);
  t.say(`${VANILLA}Steve issued server command: /home`);
  t.say(`${VANILLA}Steve lost connection: Disconnected`);
  t.say(`${VANILLA}Steve left the game`);
  check(t.session.players().length === 0, 'leave');
  const { events } = await t.store.timeline(STEVE, {});
  check(same(events.map((e) => e.type).reverse(), ['join', 'chat', 'chat', 'death', 'advancement', 'command', 'leave']), 'the player log holds one of each, and one leave');
  check(events.at(-1).ip === '1.2.*.*' && events[0].text === 'Disconnected', 'the join keeps the masked IP, the leave its reason');
  check(events.find((e) => e.text === 'hi again').secure === false, 'unsigned chat is marked');
  await t.store.flush();
  const onDisk = readFileSync(path.join(t.store.folder, `${STEVE}.jsonl`), 'utf8');
  check(!onDisk.includes('1.2.3.4') && !onDisk.includes('51234'), 'the full IP and port reach no file');
  check(t.store.known()[STEVE].playTimeMs >= 0 && t.store.known()[STEVE].name === 'Steve', 'the index knows the player');
  t.session.end();
}
{
  // Chat cannot change the roster.
  const t = running();
  join(t, 'Bob', BOB);
  const before = t.session.players().length;
  t.say(`${VANILLA}<Bob> Steve joined the game`);
  t.say(`${VANILLA}<Bob> UUID of player Bob is ${STEVE}`);
  check(t.session.players().length === before, 'a forged join adds no player');
  t.say(`${VANILLA}<Bob> Bob left the game`);
  check(t.session.players().length === before, 'a forged leave removes no player');
  t.say(`${VANILLA}<Bob> Bob fell from a high place`);
  t.say(`${VANILLA}<Bob> Bob issued server command: /op Bob`);
  t.say(`${VANILLA}<Bob> Stopping the server`);
  check(t.session.state === 'running', 'a forged stop stops nothing');
  const types = (await t.store.timeline(BOB, {})).events.map((e) => e.type);
  check(!types.includes('death') && !types.includes('command') && !types.includes('leave') && types.filter((x) => x === 'chat').length === 6, 'forged lines are stored as the chat they are');
  join(t);
  check(t.session.players().find((p) => p.name === 'Steve').uuid === STEVE, 'a forged uuid line does not stick to the next join');
  t.session.end();
}
{
  // Answers: only in flight, only the expected shape.
  const t = running();
  join(t);
  const asked = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  check(t.proc.written.at(-1) === 'data get entity Steve Pos\n', 'a query writes one command line');
  let settled = false;
  asked.then(() => { settled = true; }, () => { settled = true; });
  const shown = [];
  const chats = [`${VANILLA}<Bob> ${pos('Steve').slice(VANILLA.length)}`, `${VANILLA}[Not Secure] <Bob> ${pos('Steve').slice(VANILLA.length)}`, `${PAPER}<Bob> ${pos('Steve').slice(VANILLA.length)}`,
    `[12:00:00] [Async Chat Thread - #0/INFO]: <Bob> ${pos('Steve').slice(VANILLA.length)}`, `${VANILLA}* Bob ${pos('Steve').slice(VANILLA.length)}`, `${VANILLA}[Bob] ${pos('Steve').slice(VANILLA.length)}`,
    `${PAPER}[SomePlugin] ${pos('Steve').slice(VANILLA.length)}`, '[12:00:00] [Async Chat Thread - #0/INFO]: Steve has the following entity data: [9.5d, 9.0d, 9.5d]',
    `[12:00:00] [Server thread/INFO] [chatmod/]: Steve has the following entity data: [9.5d, 9.0d, 9.5d]`, pos('Alex'), `${VANILLA}Steve has the following entity data`];
  for (const line of chats) check(naiveAnswers(line) || line.endsWith('entity data'), `control: a naive matcher takes "${line.slice(0, 44)}"`);
  for (const line of chats) shown.push(t.say(line));
  await sleep(5);
  check(!settled, 'no forged line answers the query');
  check(same(shown, chats.map((l) => `${l}\n`)), 'and every one of them stays in the console');
  const hidden = t.say(pos('Steve', 7));
  check(hidden === '', 'the real answer is hidden from the console');
  check(await asked === '[7.5d, 64.0d, 2.5d]', 'the query gets the real answer');
  check(t.say(pos('Steve', 8)) === `${pos('Steve', 8)}\n`, 'the same line with no query in flight stays in the console');
  check(t.session.players()[0].pos.x === 1.5, 'and changes nothing');
  t.session.end();

  function naiveAnswers(line) { return /(\w+) has the following entity data: (.*)/.test(line); }
}
{
  // Serial, one in flight.
  const t = running();
  join(t);
  const a = t.session.query('list uuids', matchList(), 2000);
  const b = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  check(t.proc.written.filter((w) => w.startsWith('data')).length === 0, 'the second query waits for the first');
  check(t.say(`${VANILLA}There are 1 of a max of 20 players online: Steve (${STEVE})`) === '', 'list answer hidden');
  check(same(await a, [{ name: 'Steve', uuid: STEVE }]), 'list uuids -> names and ids');
  check(t.proc.written.at(-1) === 'data get entity Steve Pos\n', 'then the second goes out');
  t.say(pos('Steve'));
  check(!!await b, 'and is answered');
  const both = [{ name: 'Steve', uuid: STEVE }, { name: 'Bob', uuid: BOB }];
  for (const [lines, want, label] of [
    [['There are 0 of a max of 20 players online: '], [], 'nobody on'],
    [[`There are 2 of a max of 20 players online: Steve (${STEVE}), Bob (${BOB.toUpperCase()})`], both, 'two on'],
    [['There are 1/20 players online:', `Steve (${STEVE})`], both.slice(0, 1), 'the two-line answer of 1.12'],
    [['There are 2 out of maximum 20 players online.', `default: Steve (${STEVE}), Bob (${BOB})`], both, "Bukkit's list"],
    [['There are 1 of a max of 20 players online: [Admin] Steve'], null, 'a display name cannot be compared'],
    [['There are 1 of a max of 20 players online: VIPSteve'], null, 'nor a name without its id, from a list that ignores uuids'],
    [[`There are 2 of a max of 20 players online: Steve (${STEVE})`], null, 'nor a count the entries do not make'],
  ]) {
    const q = t.session.query('list uuids', matchList(), 2000);
    const out = lines.map((l) => t.say(`${PAPER}${l}`));
    check(same(await q, want) && out.every((o) => o === ''), `list: ${label}`);
  }
  const two = t.session.query('list uuids', matchList(), 2000);
  t.say(`${PAPER}There are 2/20 players online:`);
  check(t.say(`${PAPER}Saving chunks for level`) === `${PAPER}Saving chunks for level\n`, 'a stray line inside a two-line answer stays in the console');
  check(t.say(`${PAPER}Saving`) === `${PAPER}Saving\n`, 'and one word is not two names');
  t.say(`${PAPER}Steve (${STEVE}), Bob (${BOB})`);
  check(same(await two, both), 'the names still arrive');
  const bad = await errOf(() => t.session.query('data get entity Steve\nop Bob', matchData('Steve')));
  const bad2 = await errOf(() => t.session.query('x\rop Bob', matchData('Steve')));
  check(bad?.code === 'badCommand' && bad2?.code === 'badCommand' && !t.proc.written.some((w) => w.includes('op Bob')), 'a command with a line break is refused before it is written');
  const before = t.proc.written.length;
  const late = await errOf(() => t.session.query('time query', () => undefined, 30));
  check(late?.code === 'timeout', 'a query times out with code timeout');
  check(t.proc.written.length === before + 1, 'and is not sent again');
  check(t.say(`${VANILLA}Whatever the server says`) === `${VANILLA}Whatever the server says\n`, 'after a timeout lines go to the console again');
  const c = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  t.say(`${VANILLA}No entity was found`);
  check(await c === null, 'the server saying no entity answers with null');
  const stale = t.session.query('data get entity Steve Pos', matchData('Steve'), 30);
  const after = t.session.query('list uuids', matchList(), 2000);
  check((await errOf(() => stale))?.code === 'timeout' && t.proc.written.at(-1) === 'list uuids\n', 'a timeout lets the next query go');
  t.say(`${VANILLA}There are 1 of a max of 20 players online: Steve (${STEVE})`);
  await after;
  const many = [];
  for (let i = 0; i < 40; i++) many.push(t.session.query('list', () => undefined, 5).catch((err) => err.code));
  const codes = await Promise.all(many);
  check(codes.includes('busy') && codes.includes('timeout'), 'a full queue refuses with code busy');
  t.session.end();
}
{
  // An answer that comes after its query gave up is still that query's: the server answers in order.
  const t = running();
  join(t);
  const first = t.session.query('data get entity Steve Pos', matchData('Steve'), 20);
  check((await errOf(() => first))?.code === 'timeout', 'a slow answer times its query out');
  const second = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  check(t.say(pos('Steve', 1)) === '', 'its late answer is still hidden');
  t.say(pos('Steve', 2));
  const got = await second.catch((err) => err.code);
  check(got === '[2.5d, 64.0d, 2.5d]', `the next query of the same shape gets its own answer, not the late one (${got})`);

  const shapes = { ok: /^Applied effect /, refused: /^Could not apply /i };
  check(await t.session.command('effect give Steve speed', shapes, 20) === null, 'a command whose answer is slow answers null');
  const again = t.session.command('effect give Steve speed', shapes, 2000);
  t.say(`${VANILLA}Applied effect Speed to Steve`);
  t.say(`${VANILLA}Could not apply effect`);
  const said = await again;
  check(said?.refused === true && said.text === 'Could not apply effect', `and the next command gets its own refusal, not the success before it (${J(said)})`);

  // A line that answers a later query ends the wait of every one before it.
  await errOf(() => t.session.query('data get entity Steve Pos', matchData('Steve'), 20));
  const listed = t.session.query('list uuids', matchList(), 2000);
  t.say(`${VANILLA}There are 1 of a max of 20 players online: Steve (${STEVE})`);
  check(same(await listed, [{ name: 'Steve', uuid: STEVE }]), 'a query of another shape is answered while one waits for a late answer');
  const after = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  t.say(pos('Steve', 3));
  check(await after.catch((err) => err.code) === '[3.5d, 64.0d, 2.5d]', 'and after it nothing waits for that late answer any more');

  // An answer that never comes: the next query's answer is taken in its place, and that is where it stops.
  await errOf(() => t.session.query('data get entity Steve Pos', matchData('Steve'), 20));
  const robbed = t.session.query('data get entity Steve Pos', matchData('Steve'), 20);
  t.say(pos('Steve', 4));
  check((await errOf(() => robbed))?.code === 'timeout', 'a lost answer costs the next query of its shape');
  const next = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  t.say(pos('Steve', 5));
  check(await next.catch((err) => err.code) === '[5.5d, 64.0d, 2.5d]', 'but not the one after it');
  t.session.end();

  let clock = 1000;
  const s = createSession({ version: '1.21.1', store: fakeStore(freshDir()), now: () => clock, pingMs: 1, pollMs: 1000000, listMs: 1000000 });
  s.attach(new FakeProcess());
  const say = (line) => s.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say });
  await errOf(() => s.query('data get entity Steve Pos', matchData('Steve'), 20));
  clock += 11000;
  const fresh = s.query('data get entity Steve Pos', matchData('Steve'), 2000);
  say(pos('Steve', 6));
  check(await fresh.catch((err) => err.code) === '[6.5d, 64.0d, 2.5d]', 'a late answer is waited for ten seconds at most');
  s.end();
}
{
  // A stop or a crash mid-query ends everything waiting.
  const t = running();
  join(t);
  const a = t.session.query('data get entity Steve Pos', matchData('Steve'), 60000);
  const b = t.session.query('list', matchList(), 60000);
  t.say(`${VANILLA}Stopping the server`);
  check(t.session.state === 'stopping', 'the stop line is seen');
  check((await errOf(() => a))?.code === 'stopped' && (await errOf(() => b))?.code === 'stopped', 'a stop rejects the query in flight and the queue');
  check((await errOf(() => t.session.query('list', matchList())))?.code === 'notRunning', 'a stopping server takes no query');
  t.proc.emit('close', 0);
  check(t.session.state === 'stopped' && t.session.players().length === 0, 'the exit ends the session');
  const { events } = await t.store.timeline(STEVE, {});
  check(events[0].type === 'leave' && events[0].why === 'stopped', 'who was on gets a leave');

  const c = running();
  join(c);
  const d = c.session.query('data get entity Steve Pos', matchData('Steve'), 60000);
  c.proc.emit('close', 1);
  check((await errOf(() => d))?.code === 'stopped', 'a crash rejects the query in flight');
  c.proc.emit('close', 1);
  check((await c.store.timeline(STEVE, {})).events.filter((e) => e.type === 'leave').length === 1, 'an end is only ever one end');
  check((await errOf(() => c.session.query('list', matchList())))?.code === 'notRunning', 'a dead server takes no query');

  const start = createSession({ version: '1.21.1', store: fakeStore(freshDir()) });
  start.attach(new FakeProcess());
  check((await errOf(() => start.query('list', matchList())))?.code === 'notRunning', 'a starting server takes no query');
  start.filter(`${VANILLA}Steve[/1.2.3.4:1] logged in with entity id 1 at (1.0, 2.0, 3.0)\n`, 'out');
  check(start.state === 'running', 'a player logging in proves the server runs, whatever its ready line looks like');
  start.end();

  const broken = running();
  broken.proc.stdin.write = () => { throw new Error('EPIPE'); };
  check((await errOf(() => broken.session.query('list', matchList(), 60000)))?.code === 'stopped', 'a pipe that throws fails the query at once');
  broken.session.end();

  const none = createSession({ version: '1.21.1', store: fakeStore(freshDir()) });
  let ended = 0;
  const failed = createSession({ version: '1.21.1', store: fakeStore(freshDir()), onEnd: () => { ended++; } });
  failed.attach(undefined);
  check(failed.state === 'stopped' && ended === 1, 'a process that never started ends its session');
  none.end();
}
{
  // The filter on chunks as they really arrive.
  const t = running();
  join(t);
  const raw = 'half a li';
  check(t.session.filter(raw, 'out') === raw, 'idle: a half line goes to the console at once');
  check(t.session.filter('ne\n', 'out') === 'ne\n', 'idle: and the rest of it');
  const text = `a\r\nb\n\n${VANILLA}Saving\n  stack\tframe\n`;
  check(t.session.filter(text, 'out') === text, 'idle: text passes unchanged');
  check(t.session.filter('anything\n', 'err') === 'anything\n', 'stderr is left alone');
  const q = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  const line = pos('Steve', 3);
  let out = '';
  for (let i = 0; i < line.length; i += 7) out += t.session.filter(line.slice(i, i + 7), 'out');
  out += t.session.filter('\n', 'out');
  check(out === '', 'an answer split across seven-character chunks is hidden');
  check(await q === '[3.5d, 64.0d, 2.5d]', 'and read');
  const q2 = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  const mixed = t.session.filter(`${VANILLA}<Bob> hi\n${pos('Steve', 4)}\n${VANILLA}Saved\n`, 'out');
  check(mixed === `${VANILLA}<Bob> hi\n${VANILLA}Saved\n`, 'an answer between other lines is cut out of one chunk');
  await q2;
  const held = t.session.filter('before ', 'out');
  const q3 = t.session.query('data get entity Steve Pos', matchData('Steve'), 2000);
  check(held === 'before ', 'a half line from before the query has gone out');
  const tail = t.session.filter(`${pos('Steve', 5)}\n`, 'out');
  check(tail === `${pos('Steve', 5)}\n`, 'its end stays visible: the console already has its start');
  t.say(pos('Steve', 6));
  await q3;
  const q4 = t.session.query('data get entity Steve Pos', matchData('Steve'), 40);
  check(t.session.filter('held back', 'out') === '', 'during a query a half line waits');
  await errOf(() => q4);
  check(t.session.filter(' more', 'out') === 'held back more', 'after the query it goes out with the next text');
  t.session.filter('\n', 'out');
  const q5 = t.session.query('data get entity Steve Pos', matchData('Steve'), 60000);
  t.session.filter('last words', 'out');
  check(t.session.filter.flush() === 'last words', 'the process exit gets what was held');
  check(t.session.filter.flush() === '', 'once');
  t.proc.emit('close', 0);
  await errOf(() => q5);

  const big = running();
  join(big);
  const q6 = big.session.query('data get entity Steve', matchData('Steve'), 2000);
  const inventory = `{Inventory: [${Array.from({ length: 20000 }, (_, i) => `{Slot: 0b, id: "minecraft:stone", count: ${i}}`).join(', ')}], Health: 20.0f}`;
  check(big.say(`${VANILLA}Steve has the following entity data: ${inventory}`) === '', `a ${(inventory.length / 1024) | 0} KiB answer on one line`);
  check(parseSnbt(await q6).Inventory.length === 20000, 'is read whole');
  let shown = big.session.filter('x'.repeat(3 << 20), 'out') + big.session.filter('x'.repeat(3 << 20), 'out');
  shown += big.session.filter('\n', 'out');
  check(shown.length === (6 << 20) + 1, 'a line past the limit is shown and not kept');
  check(big.say(`${VANILLA}Steve left the game`) !== undefined && big.session.players().length === 0, 'parsing goes on after it');
  big.session.end();

  // A flood must not be slowed down by the tap.
  const flood = running();
  join(flood);
  const lines = Array.from({ length: 200000 }, (_, i) => `${VANILLA}<Steve> message ${i}\n`).join('');
  const t0 = performance.now();
  flood.session.filter(lines, 'out');
  const ms = performance.now() - t0;
  // Far past what a server prints, and what it guards against is growth with the line count. A slow runner takes twice this PC's time.
  check(ms < 5000, `200,000 chat lines parsed and queued in ${ms | 0} ms`);
  await flood.store.flush();
  flood.session.end();
}
{
  // Polling, with real short timers and a process that answers.
  const t = running({ pollMs: 5, listMs: 25 });
  const written = () => t.proc.written.length;
  await sleep(60);
  check(written() === 0, 'nobody on: no polling');
  t.proc.answer = (cmd) => {
    if (cmd === 'list uuids') t.say(`${VANILLA}There are 1 of a max of 20 players online: Steve (${STEVE})`);
    else if (cmd.endsWith(' Pos')) t.say(pos('Steve', 9));
    else if (cmd.endsWith(' Dimension')) t.say(`${VANILLA}Steve has the following entity data: "minecraft:the_nether"`);
  };
  join(t);
  check(await waitFor(() => t.proc.written.includes('list uuids\n')), 'the roster is reconciled with list uuids');
  await sleep(40);
  check(!t.proc.written.some((w) => w.startsWith('data')), 'no position polling while the tab is closed');
  t.session.watch(true);
  check(await waitFor(() => t.session.players()[0]?.pos?.dimension === 'minecraft:the_nether'), 'tab open: position and dimension are polled');
  check(t.session.players()[0].pos.x === 9.5 && await waitFor(() => t.pings.includes('position')), 'and pushed to the window');
  t.session.watch(false);
  await sleep(20);
  const count = t.proc.written.filter((w) => w.startsWith('data')).length;
  await sleep(40);
  check(t.proc.written.filter((w) => w.startsWith('data')).length === count, 'tab closed: position polling stops');
  t.say(`${VANILLA}Stopping the server`);
  await sleep(10);
  const stopped = written();
  await sleep(40);
  check(written() === stopped, 'no polling while stopping');
  t.session.end();

  let clock = 1000;
  const lease = running({ pollMs: 5, listMs: 100000000, now: () => clock });
  lease.proc.answer = (cmd) => { if (cmd.endsWith(' Pos')) lease.say(pos('Steve')); else if (cmd.endsWith(' Dimension')) lease.say(`${VANILLA}Steve has the following entity data: "minecraft:overworld"`); };
  join(lease);
  lease.session.watch(true);
  await sleep(40);
  const seen = lease.proc.written.length;
  check(seen > 0, 'a watch polls');
  clock += 31000;
  await sleep(20);
  const settled = lease.proc.written.length;
  await sleep(30);
  check(lease.proc.written.length === settled, 'a watch nobody renews runs out');
  lease.session.end();

  // list has the last word on join and leave lines that were missing.
  const r = running({ pollMs: 5, listMs: 1 });
  let names = `Bob (${BOB})`;
  r.proc.answer = (cmd) => { if (cmd === 'list uuids') r.say(`${VANILLA}There are 1 of a max of 20 players online: ${names}`); };
  join(r);
  check(await waitFor(() => r.session.players().map((p) => p.name).join() === 'Bob'), 'list drops who is gone and adds who is there');
  check(r.session.players()[0].uuid === BOB, 'by the id the list gives, not one derived from the name');
  const steve = await r.store.timeline(STEVE, {});
  check(steve.events[0].type === 'leave' && steve.events[0].why === 'reconciled', 'a reconciled leave says so');
  names = '[Admin] Bob';
  await sleep(30);
  check(r.session.players().length === 1, 'display names change nothing');
  r.session.end();

  // A team's prefix or suffix is glued to the display name, which join, leave, chat and plain `list` print; the login
  // lines and `list uuids` print the name itself.
  const v = running({ pollMs: 5, listMs: 1 });
  let on = [['Steve', STEVE]];
  v.proc.answer = (cmd) => {
    if (cmd === 'list') v.say(`${VANILLA}There are ${on.length} of a max of 20 players online: ${on.map(([n]) => `VIP${n}`).join(', ')}`);
    if (cmd === 'list uuids') v.say(`${VANILLA}There are ${on.length} of a max of 20 players online: ${on.map(([n, u]) => `${n} (${u})`).join(', ')}`);
  };
  v.say(`[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${STEVE}`);
  v.say(`${VANILLA}Steve[/1.2.3.4:51234] logged in with entity id 1 at (1.5, 64.0, 2.5)`);
  v.say(`${VANILLA}VIPSteve joined the game`);
  check(v.session.players().map((p) => p.name).join() === 'Steve', 'a join line with a team prefix makes no second player');
  await waitFor(() => v.proc.written.filter((w) => w.startsWith('list')).length >= 3);
  check(v.session.players().map((p) => p.name).join() === 'Steve', 'and the list keeps the real one on');
  v.say(`${VANILLA}<VIPSteve> hello`);
  v.say(`${VANILLA}VIPSteve left the game`);
  check(v.session.players().length === 1, 'a leave line with the prefix is nobody on');
  const steveV = (await v.store.timeline(STEVE, {})).events.map((e) => e.type);
  check(same(steveV, ['chat', 'join']), `Steve's record: his join and his chat, no leave (${steveV})`);
  on = [['Bob', BOB]];
  check(await waitFor(() => v.session.players().map((p) => p.name).join() === 'Bob'), 'the list by id still drops who is gone and adds who is there');
  // A backend behind a proxy logs no uuid line, so the id was derived from the name; the list says whose it is.
  v.say(`${VANILLA}Kim[/1.2.3.4:51234] logged in with entity id 2 at (1.5, 64.0, 2.5)`);
  check(v.session.players().find((p) => p.name === 'Kim')?.uuid === offlineUuid('Kim'), 'control: a login with no uuid line gets the offline id');
  on = [['Bob', BOB], ['Kim', STEVE]];
  check(await waitFor(() => v.session.players().find((p) => p.name === 'Kim')?.uuid === STEVE), 'and the list puts the real one in its place');
  v.session.end();

  const old = running({ version: '1.12.2', pollMs: 5, listMs: 100000000 });
  join(old);
  old.session.watch(true);
  await sleep(30);
  check(!old.proc.written.some((w) => w.startsWith('data')) && old.session.hasData === false, 'no data command below 1.13');
  old.session.end();
  check(running({ version: '26.3' }).session.hasData === true && running({ version: '1.13' }).session.hasData === true, 'the data command from 1.13, and in the new numbering');
}
{
  // Whose id a line belongs to.
  const t = running();
  t.session.learn(new Map([['Alex', BOB]]));
  const loggedIn = (name) => t.say(`${VANILLA}${name}[/1.2.3.4:51234] logged in with entity id 1 at (1.5, 64.0, 2.5)`);
  loggedIn('Alex');
  check(t.session.players()[0].uuid === BOB, 'usercache gives the uuid when no line did');
  loggedIn('Pat');
  check(t.session.players().find((p) => p.name === 'Pat').uuid === offlineUuid('Pat'), 'offline mode: the uuid the server derives from the name');
  t.say(`${VANILLA}Alex joined the game`);
  check(t.session.players().length === 2, 'a join line after the login is the same player');
  t.say(`${VANILLA}Kim joined the game`);
  check(t.session.players().length === 2, 'a join line of a name no login line gave is no player: a team prefix can make one');
  t.say(`[12:00:00] [User Authenticator #1/INFO]: UUID of player Kim is ${STEVE}`);
  t.say(`${VANILLA}Kim joined the game`);
  check(t.session.players().find((p) => p.name === 'Kim')?.uuid === STEVE, 'one whose uuid line came is');
  t.say(`${VANILLA}Nobody left the game`);
  t.say(`${VANILLA}Nobody fell from a high place`);
  check(t.session.players().length === 3, 'a leave of someone not on changes nothing');
  t.session.end();
}
{
  // A proxy: no parsing, nothing written.
  const dir = freshDir();
  const proxy = createSession({ version: '3.4', proxy: true, store: fakeStore(dir) });
  const proc = new FakeProcess();
  proxy.attach(proc);
  check(proxy.filter(`${VANILLA}Steve joined the game\n`, 'out') === `${VANILLA}Steve joined the game\n`, 'a proxy session only passes text through');
  check(proxy.players().length === 0 && !existsSync(path.join(dir, '.nano')), 'and keeps nothing');
  proc.emit('close', 0);
  check(proxy.state === 'stopped', 'and ends with its process');
}
{
  // A match that throws must not reach the process's data event.
  const t = running();
  const q = t.session.query('list', () => { throw new Error('boom'); }, 20);
  check(t.say(`${VANILLA}something`) === `${VANILLA}something\n`, 'a match that throws leaves the line alone');
  check((await errOf(() => q))?.code === 'timeout', 'and the query times out');
  t.session.end();
}

// ---------- the server's own files ----------
const put = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
const serverDir = () => {
  const dir = freshDir();
  put(path.join(dir, 'server.properties'), 'level-name=myworld\n');
  put(path.join(dir, 'usercache.json'), J([{ name: 'Steve', uuid: STEVE, expiresOn: 'x' }, { name: 'Bad', uuid: 'nope' }]));
  put(path.join(dir, 'ops.json'), `﻿${J([{ uuid: STEVE, name: 'Steve', level: 3, bypassesPlayerLimit: false }])}`);
  put(path.join(dir, 'whitelist.json'), J([{ uuid: BOB, name: 'Bob' }]));
  put(path.join(dir, 'banned-players.json'), J([{ uuid: BOB, name: 'Bob', created: 'x', source: 'x', expires: 'forever', reason: 'x' },
    { uuid: '00000000-0000-3000-8000-000000000001', name: 'Past', expires: '2020-01-01 00:00:00 +0000', reason: 'x' }]));
  return dir;
};
{
  const dir = serverDir();
  check(worldOf(dir) === path.join(dir, 'myworld'), 'the world folder comes from level-name');
  put(path.join(dir, 'server.properties'), 'level-name=../../outside\n');
  check(worldOf(dir) === path.join(dir, 'world'), 'a level-name outside the server is not followed');
  put(path.join(dir, 'server.properties'), 'level-name=myworld\n');
  const cache = await readUsercache(dir);
  check(cache.get('Steve') === STEVE && !cache.has('Bad'), 'usercache.json, a bad id left out');
  const flags = await readFlags(dir);
  check(same(flags.of(STEVE, 'Steve'), { op: true, opLevel: 3, whitelisted: false, banned: false }), 'ops.json with a BOM: op and level');
  check(same(flags.of(BOB, 'Bob'), { op: false, opLevel: 0, whitelisted: true, banned: true }), 'whitelisted and banned');
  check(flags.of('00000000-0000-3000-8000-000000000001', 'Past').banned === false, 'a ban that ran out');
  check(flags.of('ffffffff-ffff-3fff-bfff-ffffffffffff', 'BOB').banned === true, 'a name in another case');
  check(same(flags.of(STEVE, 'x').opLevel, 3), 'a uuid alone is enough');
  check((await readFlags(freshDir())).of(STEVE, 'Steve').op === false, 'no list files: no flags');

  const data = path.join(dir, 'myworld', 'playerdata', `${STEVE}.dat`);
  const packed = zlib.gzipSync(newPlayer);
  put(data, packed);
  const stamp = statSync(data).mtimeMs;
  put(path.join(dir, 'myworld', 'stats', `${STEVE}.json`), J({ stats: { 'minecraft:custom': { 'minecraft:play_time': 720, 'minecraft:deaths': 2, 'minecraft:mob_kills': 9, 'minecraft:jump': 44 } }, DataVersion: 3955 }));
  put(path.join(dir, 'myworld', 'advancements', `${STEVE}.json`), J({ 'minecraft:story/root': { done: true }, 'minecraft:story/x': { done: false }, 'minecraft:recipes/misc/y': { done: true }, DataVersion: 3955 }));
  const d = await readDetail(dir, STEVE);
  check(d.source === 'file' && d.health === 18.5 && d.pos.dimension === 'minecraft:the_nether' && sword(d.inventory[0]), 'detail from playerdata');
  check(same(d.stats, { playTimeTicks: 720, deaths: 2, mobKills: 9, jumps: 44 }) && d.advancements === 1, 'stats; advancements without recipes');
  check(statSync(data).mtimeMs === stamp && readFileSync(data).equals(packed), 'the player file is not written');

  put(path.join(dir, 'myworld', 'stats', `${BOB}.json`), J({ 'stat.playOneMinute': 100, 'stat.deaths': 1, 'stat.mobKills': 3, 'stat.jump': 4 }));
  put(path.join(dir, 'myworld', 'playerdata', `${BOB}.dat`), packed.subarray(0, 30));
  const bad = await readDetail(dir, BOB);
  check(bad.code === 'damaged' && /damaged/.test(bad.error) && bad.error.includes(`${BOB}.dat`), `a damaged file is a readable value: ${bad.error}`);
  check(same(bad.stats, { playTimeTicks: 100, deaths: 1, mobKills: 3, jumps: 4 }), 'the old stats layout, still there beside a damaged file');
  const missing = await readDetail(dir, 'aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa');
  check(missing.code === 'missing' && missing.source === 'file', 'no file yet is a value too');
  put(path.join(dir, 'myworld', 'players', 'data', 'bbbbbbbb-bbbb-3bbb-8bbb-bbbbbbbbbbbb.dat'), packed);
  check((await readDetail(dir, 'bbbbbbbb-bbbb-3bbb-8bbb-bbbbbbbbbbbb')).health === 18.5, 'the players/data layout of 26.x');
}

// ---------- the IPC core, with the real actions.js ----------
{
  const dir = serverDir();
  put(path.join(dir, 'myworld', 'playerdata', `${BOB}.dat`), zlib.gzipSync(oldPlayer));
  const pushes = [];
  const kind = { version: '1.21.1', kind: 'paper', proxy: false };
  const players = createPlayers({ send: (ch, p) => pushes.push([ch, p]), describe: () => kind, sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
  let list = await players.list(dir);
  check(list.running === false && list.proxy === false, 'list of a stopped server');
  check(list.players.map((p) => p.name).sort().join() === 'Bob,Past,Steve', 'known players come from usercache and the lists');
  check(list.players.find((p) => p.name === 'Steve').opLevel === 3 && list.players.find((p) => p.name === 'Bob').banned, 'with their flags');
  check((await players.action(dir, { type: 'kick', target: 'Steve' })).code === 'notRunning', 'an action on a stopped server is a value');

  const session = players.begin(dir);
  const proc = new FakeProcess();
  session.attach(proc);
  const say = (line) => session.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say });
  await sleep(5);
  list = await players.list(dir);
  const steve = list.players[0];
  check(list.running && steve.online && steve.name === 'Steve' && steve.pos?.x === 1.5 && typeof steve.playTimeMs === 'number', 'list: who is on comes first, with a position');
  check(pushes.some(([ch, p]) => ch === 'minecraft:players' && p.dir === dir && p.kind === 'roster'), 'a join pushes minecraft:players {dir, kind}');

  proc.answer = (cmd) => { if (cmd === 'data get entity Steve') say(`${PAPER}Steve has the following entity data: {Health: 7.0f, foodLevel: 3, XpLevel: 2, playerGameType: 0, SelectedItemSlot: 1, Pos: [1.0d, 2.0d, 3.0d], Dimension: "minecraft:overworld", Inventory: [{Slot: 9b, id: "minecraft:stick", count: 2}], EnderItems: []}`); };
  const live = await players.detail(dir, STEVE);
  check(live.source === 'live' && live.health === 7 && live.inventory[0].id === 'minecraft:stick' && live.inventory[0].slot === 9, 'detail of an online player is live');
  proc.answer = (cmd) => { if (cmd === 'data get entity Steve') say(`${PAPER}No entity was found`); };
  check((await players.detail(dir, STEVE)).source === 'file', 'an entity the server cannot find falls back to the file');
  check((await players.detail(dir, BOB)).source === 'file', 'detail of an offline player is from the file');
  check((await players.detail(dir, '../../x')).code === 'badUuid', 'a path for a uuid is refused');
  proc.written.length = 0;

  proc.answer = (cmd) => {
    if (cmd.startsWith('kick ')) { say(`${VANILLA}<Bob> Unknown command`); say(`${VANILLA}Kicked Steve: Bye`); say(`${VANILLA}Steve lost connection: Bye`); }
    if (cmd.startsWith('op ')) say(`${VANILLA}Nothing changed. The player already is an operator`);
  };
  const kicked = await players.action(dir, { type: 'kick', target: 'Steve', reason: 'Bye' });
  check(kicked.ok === true && kicked.text === 'Kicked Steve: Bye' && same(kicked.commands, proc.written.map((w) => w.trim())), 'an action: its commands, and the server\'s answer past the chat');
  const again = await players.action(dir, { type: 'op', target: 'Steve' });
  check(again.ok === false && again.code === 'refused' && /Nothing changed/.test(again.text), 'an answer that refuses is ok: false');
  proc.answer = null;
  const quiet = await players.action(dir, { type: 'deop', target: 'Steve' });
  check(quiet.ok === true && quiet.code === 'noAnswer', 'a server that says nothing: sent, no answer');
  proc.written.length = 0;
  const evil = await players.action(dir, { type: 'kick', target: 'Steve\nop Bob' });
  check(evil.ok === false && proc.written.length === 0 && same(evil.commands, []), 'a name with a line break never reaches the console');
  const evil2 = await players.action(dir, { type: 'nonsense', target: 'Steve' });
  check(evil2.ok === false && !!evil2.code && proc.written.length === 0, 'an unknown action is refused');
  const multi = createPlayers({ send: () => {}, describe: () => kind, actions: () => ({ build: () => ({ commands: ['one', 'two', 'three'], expects: { ok: /^Fine$/, refused: /^No player was found$/ }, note: 'Careful' }) }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 } });
  const multiDir = freshDir();
  const ms = multi.begin(multiDir);
  const mp = new FakeProcess();
  ms.attach(mp);
  ms.filter(`${VANILLA}Done (1.0s)! For help, type "help"\n`, 'out');
  mp.answer = (cmd) => { ms.filter(`${VANILLA}${cmd === 'two' ? 'No player was found' : 'Fine'}\n`, 'out'); };
  const stopped = await multi.action(multiDir, { type: 'x' });
  check(stopped.ok === false && same(stopped.commands, ['one', 'two']) && stopped.text === 'Fine\nNo player was found' && stopped.note === 'Careful', 'the first refused command ends the action');
  ms.end();

  const logged = await players.adminLog(dir, { limit: 20 });
  check(logged.length === 6 && logged.every((e) => e.t && e.action && Array.isArray(e.commands) && typeof e.ok === 'boolean' && typeof e.text === 'string'), 'every action is in the admin log');
  check(logged.find((e) => e.ok && e.text.startsWith('Kicked'))?.commands.length === 1, 'with its commands and the answer');

  const timeline = await players.timeline(dir, STEVE, { limit: 5 });
  check(timeline.events.length >= 2 && timeline.events.at(-1).type === 'join', 'timeline through the core');
  check((await players.search(dir, { types: ['leave'] })).length === 1, 'search through the core');
  check(players.watch(dir, true) === true && players.watch(freshDir(), true) === true, 'watch is harmless without a session');

  players.begin(dir).end();
  const quit = players.begin(dir);
  const quitProc = new FakeProcess();
  quit.attach(quitProc);
  quit.filter(`${VANILLA}Done (1.0s)! For help, type "help"\n`, 'out');
  join({ say: (l) => quit.filter(`${l}\n`, 'out') }, 'Alex', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  players.closeAll();
  const file = path.join(dir, '.nano', 'players', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl');
  check(quit.state === 'stopped' && existsSync(file) && readFileSync(file, 'utf8').includes('"leave"'), 'closeAll at quit writes everything before returning');

  const proxied = createPlayers({ send: () => {}, describe: () => ({ version: '3.4', kind: 'velocity', proxy: true }) });
  const px = freshDir();
  const pxSession = proxied.begin(px);
  check(same(await proxied.list(px), { running: true, state: 'starting', proxy: true, players: [] }), 'a proxy says so and lists nobody');
  pxSession.attach(new FakeProcess());
  check((await proxied.list(px)).state === 'running', 'a proxy whose process runs is running: no line of its output will ever say so');
  pxSession.end();
  check((await proxied.action(px, { type: 'kick', target: 'x' })).code === 'proxy' && !existsSync(path.join(px, '.nano')), 'an action on a proxy is refused and logs nothing');
  const noServer = createPlayers({ send: () => {}, describe: () => { throw new Error('no server'); } });
  check(noServer.begin(freshDir()) === null, 'a process that is no server gets no session');
}
{
  // A name can pass to another account. op, ban, pardon and the whitelist resolve the name they are sent through the
  // server's own cache (GameProfileArgument of 1.20.1 and 26.3 takes no uuid), so a row's name must still be its account's.
  const dir = freshDir();
  const [OLD, NEW] = ['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002'];
  const [SOON, PAST] = ['2099-01-01 00:00:00 +0000', '2020-01-01 00:00:00 +0000'];
  put(path.join(dir, 'usercache.json'), J([{ name: 'Steve', uuid: STEVE, expiresOn: SOON }, { name: 'Moved', uuid: NEW, expiresOn: SOON },
    { name: 'Stale', uuid: OLD, expiresOn: PAST }, { name: 'Twice', uuid: OLD, expiresOn: SOON }, { name: 'twice', uuid: NEW, expiresOn: SOON },
    { name: 'Odd', uuid: OLD, expiresOn: 'whenever' }]));
  const players = createPlayers({ send: () => {}, describe: () => ({ version: '1.21.1', kind: 'paper', proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
  const session = players.begin(dir);
  const proc = new FakeProcess();
  session.attach(proc);
  const say = (line) => session.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say }, 'Bob', BOB);
  proc.answer = (cmd) => {
    const m = /^(\S+(?: add| remove)?) (\S+)/.exec(cmd);
    const said = { op: `Made ${m[2]} a server operator`, deop: `Made ${m[2]} no longer a server operator`, ban: `Banned ${m[2]}: Banned by an operator.`, pardon: `Unbanned ${m[2]}`,
      'whitelist add': `Added ${m[2]} to the whitelist`, kick: `Kicked ${m[2]}: Bye` }[m[1]];
    if (said) say(`${VANILLA}${said}`);
  };
  const sent = async (act) => { proc.written.length = 0; const r = await players.action(dir, act); return { ...r, wrote: proc.written.map((w) => w.trim()).join('|') }; };
  let r = await sent({ type: 'op', target: 'Steve', uuid: STEVE });
  check(r.ok && r.wrote === 'op Steve', `offline, a name the server's cache gives this account goes out (${r.code ?? r.wrote})`);
  r = await sent({ type: 'whitelistAdd', target: 'steve', uuid: STEVE });
  check(r.ok && r.wrote === 'whitelist add steve', 'in any case, as the cache looks names up');
  for (const [act, label] of [[{ type: 'op', target: 'Moved', uuid: OLD }, 'the cache gives the name to another account'],
    [{ type: 'whitelistAdd', target: 'Stale', uuid: OLD }, 'the entry ran out, so the server would ask Mojang who has the name now'],
    [{ type: 'ban', target: 'Nobody', uuid: OLD }, 'the name is not in the cache'], [{ type: 'pardon', target: 'Twice', uuid: OLD }, 'two accounts hold the name'],
    [{ type: 'deop', target: 'Odd', uuid: OLD }, 'an expiry the server could not read'], [{ type: 'op', target: 'Bob', uuid: OLD }, 'another account is online under the name']]) {
    r = await sent(act);
    check(!r.ok && r.code === 'otherAccount' && r.wrote === '' && same(r.commands, []), `refused, nothing sent: ${label} (${r.code ?? r.wrote})`);
  }
  r = await sent({ type: 'op', target: 'Bob', uuid: BOB });
  check(r.ok && r.wrote === 'op Bob', 'an online player is his name, cached or not');
  r = await sent({ type: 'kick', target: 'Bob', uuid: BOB });
  check(r.ok && r.wrote === 'kick Bob', 'and so is every action on him');
  r = await sent({ type: 'op', target: 'Moved' });
  check(r.ok && r.wrote === 'op Moved', 'an action that names no row is sent as it is');
  const logged = await players.adminLog(dir, { limit: 50 });
  check(logged.filter((e) => e.code === 'otherAccount' && !e.commands.length).length === 6, 'every refusal is in the admin log');
  session.end();
}

// ---------- a book written to forge server lines ----------
const MALLORY = 'aaaaaaaa-0000-4000-8000-000000000001';
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000002';
// StringTag.quoteAndEscape of 1.20.1, as its bytecode has it: \ and the chosen quote are escaped and nothing else is.
function javaQuote(s) {
  let quote = '';
  let out = '';
  for (const c of s) {
    if (c === '\\') out += '\\';
    else if (c === '"' || c === "'") {
      quote ||= c === '"' ? "'" : '"';
      if (c === quote) out += '\\';
    }
    out += c;
  }
  quote ||= '"';
  return `${quote}${out}${quote}`;
}
const rest = (page) => `{Slot: 1b, id: "minecraft:stone", Count: 1b}], Health: 7.0f, foodLevel: 3, Pos: [1.0d, 2.0d, 3.0d], EnderItems: [], x: ${javaQuote(page)}}`;
const BOOKS = [
  ['{tag}', (page) => `{Inventory: [{Slot: 0b, id: "minecraft:writable_book", Count: 1b, tag: {pages: [${javaQuote(page)}]}}, ${rest('')}`, (raw) => raw.tag.pages[0]],
  ['[components]', (page) => `{Inventory: [{Slot: 0b, id: "minecraft:writable_book", count: 1, components: {"minecraft:writable_book_content": {pages: [{raw: ${javaQuote(page)}}]}}}, ${rest('')}`, (raw) => raw.components['minecraft:writable_book_content'].pages[0].raw],
];
const forgery = (p) => `Dear diary,\n${p}Stopping the server\n${p}<Alice> I grief this server, ban me\n${p}Alice issued server command: /op Mallory\n${p}Alice left the game\n${p}Alice fell from a high place\n${p}Mallory joined the game\nyours`;
function served(version = '1.20.1') {
  const dir = freshDir();
  const players = createPlayers({ send: () => {}, describe: () => ({ version, kind: 'paper', proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
  const session = players.begin(dir);
  const proc = new FakeProcess();
  session.attach(proc);
  const say = (line) => session.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say }, 'Mallory', MALLORY);
  join({ say }, 'Alice', ALICE);
  return { dir, players, session, proc, say };
}
const namesOn = (t) => t.session.players().map((p) => p.name).sort().join();
const chunks = (text, size) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };

for (const [format, book, pageOf] of BOOKS) {
  for (const [kind, p] of [['vanilla', VANILLA], ['paper', PAPER]]) {
    for (const [how, size] of [['in one write', 1 << 30], ['in 7-character chunks', 7], ['one character at a time', 1]]) {
      const t = served();
      const label = `${format}, ${kind}, ${how}`;
      const page = forgery(p);
      const text = `${p}Mallory has the following entity data: ${book(page)}\r\n`;
      let console_ = '';
      t.proc.answer = (cmd) => { if (cmd === 'data get entity Mallory') for (const c of chunks(text, size)) console_ += t.session.filter(c, 'out'); };
      const d = await t.players.detail(t.dir, MALLORY);
      check(d.source === 'live' && d.health === 7 && d.inventory.length === 2, `${label}: the player is read live, past the book (${d.source}, ${d.error ?? ''})`);
      check(pageOf(d.inventory[0].raw) === page, `${label}: the page comes back whole`);
      check(t.session.state === 'running', `${label}: a forged stop stops nothing`);
      check(console_ === '', `${label}: the console shows none of it`);
      check(namesOn(t) === 'Alice,Mallory', `${label}: forged leaves and joins change nobody`);
      t.proc.answer = (cmd) => { if (cmd.startsWith('effect give Alice')) t.say(`${p}Applied effect Instant Health to Alice`); };
      const healed = await t.players.action(t.dir, { type: 'heal', target: 'Alice' });
      check(healed.ok === true && healed.text === 'Applied effect Instant Health to Alice', `${label}: actions still work, ${healed.code ?? 'ok'}`);
      const alice = await t.players.timeline(t.dir, ALICE, {});
      check(same(alice.events.map((e) => e.type), ['join']), `${label}: Alice's record holds only her join: ${alice.events.map((e) => e.type)}`);
      check(same((await t.players.timeline(t.dir, MALLORY, {})).events.map((e) => e.type), ['join']), `${label}: Mallory's too`);
      t.session.end();
    }
  }
}
check(parseSnbt('{a: "one\ntwo"}').a === 'one\ntwo', 'a raw line break is part of a text');
{
  const end = (text) => snbtEnd().push(text, 0);
  check(end('{a: 1}\n') === 7 && end('[1, 2]\r\n') === 8 && end('"x"\n') === 4 && end('20.0f\n') === 6, 'a value ends at the line break after it');
  check(end('{a: "b\n') === -1 && end("{a: 'b\n") === -1, 'a line break in a text is not the end, with either quote');
  check(end('{a: "it\'s"}\n') === 12 && end("{a: 'say \"hi\"'}\n") === 16, 'the other quote does not close a text');
  check(end('{a: "b\\"\n') === -1 && end('{a: "b\\\\"}\n') === 11, 'an escaped quote stays in the text, an escaped backslash does not take the quote with it');
  check(end('{a: 1\n') === 6, 'a line break outside a text ends it, however many brackets are open: the game never prints one there');
  const two = snbtEnd();
  check(two.push('{a: "one', 0) === -1 && two.push('\n', 0) === -1 && two.push('two"}', 0) === -1 && two.push('\n', 0) === 1 && two.lines === 1, 'it can be fed in pieces');
}
{
  // Random pages, printed by the game's own rule, in random pieces: no page may leave its text.
  let seed = 20261101;
  const random = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
  const ATOMS = ['"', "'", '\\', '\n', '\n', '[', ']', '{', '}', 'a', ' ', '§', '안녕', `${VANILLA}Stopping the server`, `${PAPER}Alice left the game`, `${VANILLA}<Alice> forged`, '"}]}', "'}]}", `\n${VANILLA}Mallory has the following entity data: {"`];
  const t = served();
  const round = 1500;
  let broken = null;
  for (let i = 0; i < round && !broken; i++) {
    const page = Array.from({ length: 1 + random(12) }, () => ATOMS[random(ATOMS.length)]).join('');
    const [, book, pageOf] = BOOKS[i % 2];
    const text = `${VANILLA}Mallory has the following entity data: ${book(page)}\n`;
    const q = t.session.query('data get entity Mallory', matchData('Mallory'), 2000);
    let shown = '';
    for (let at = 0; at < text.length;) { const n = 1 + random(40); shown += t.session.filter(text.slice(at, at + n), 'out'); at += n; }
    const got = parseSnbt(await q);
    if (pageOf(slotOf(got.Inventory[0]).raw) !== page || got.Health !== 7 || shown) broken = J({ page, shown });
  }
  check(!broken, `${round} random pages stay in their text: ${broken ?? 'all read back whole'}`);
  check(t.session.state === 'running' && namesOn(t) === 'Alice,Mallory', 'and none of them changed the server\'s state');
  check(same((await t.players.timeline(t.dir, ALICE, {})).events.map((e) => e.type), ['join']), 'or anyone\'s record');
  t.session.end();
}
{
  // Past the caps the rest of the book is still read, because that is where a forger would put a line.
  const t = served();
  const q = t.session.query('data get entity Mallory', matchData('Mallory'), 60000);
  const page = `${'\n'.repeat(100100)}${forgery(VANILLA)}`;
  const shown = t.say(`${VANILLA}Mallory has the following entity data: ${BOOKS[0][1](page)}`);
  check((await errOf(() => q))?.code === 'tooLong', 'an answer of too many lines fails its query');
  check(shown === '' && t.session.state === 'running' && namesOn(t) === 'Alice,Mallory', 'and what comes after the cap forges nothing');
  const after = t.session.query('data get entity Alice Pos', matchData('Alice'), 2000);
  t.say(pos('Alice', 4));
  check(await after === '[4.5d, 64.0d, 2.5d]', 'the next query works');

  const big = t.session.query('data get entity Mallory', matchData('Mallory'), 60000);
  const huge = `${'x'.repeat(5 << 20)}\n${forgery(VANILLA)}`;
  let out = '';
  for (const c of chunks(`${VANILLA}Mallory has the following entity data: ${BOOKS[1][1](huge)}\n`, 1 << 18)) out += t.session.filter(c, 'out');
  check(pageOfBig(parseSnbt(await big)) === huge, 'a first line past the line limit is still the answer, and is read whole');
  check(out === '' && t.session.state === 'running' && namesOn(t) === 'Alice,Mallory', 'and nothing after it parses as a line');

  const over = t.session.query('data get entity Mallory', matchData('Mallory'), 60000);
  let out2 = '';
  for (const c of chunks(`${VANILLA}Mallory has the following entity data: ${BOOKS[0][1](`${'y'.repeat(17 << 20)}\n${forgery(VANILLA)}`)}\n`, 1 << 20)) out2 += t.session.filter(c, 'out');
  check((await errOf(() => over))?.code === 'tooLong' && out2 === '' && t.session.state === 'running', 'an answer past the size limit fails, and forges nothing');
  t.session.end();

  function pageOfBig(root) { return BOOKS[1][2](root.Inventory[0]); }
}
{
  // A query that gave up does not end the answer it started.
  const t = served();
  const q = t.session.query('data get entity Mallory', matchData('Mallory'), 15);
  const first = `${VANILLA}Mallory has the following entity data: {pages: ["start`;
  check(t.say(first) === '', 'the first line of an open answer is hidden');
  check((await errOf(() => q))?.code === 'timeout', 'its query times out');
  check(t.say(`${VANILLA}Stopping the server`) === '' && t.session.filter('half a li', 'out') === '', 'the answer goes on being hidden, half lines too');
  check(t.session.state === 'running', 'and goes on forging nothing');
  check(t.say('ne"]}') === '', 'until its end');
  check(t.say(`${VANILLA}Saving`) === `${VANILLA}Saving\n`, 'then the console is back');
  check(t.say(`${VANILLA}Alice left the game`) !== undefined && namesOn(t) === 'Mallory', 'and so are events');
  t.session.end();

  let clock = 1000;
  const s = createSession({ version: '1.20.1', store: fakeStore(freshDir()), now: () => clock, pingMs: 1, pollMs: 1000000, listMs: 1000000 });
  s.attach(new FakeProcess());
  const say = (line) => s.filter(`${line}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say }, 'Mallory', MALLORY);
  const late = s.query('data get entity Mallory', matchData('Mallory'), 20);
  say(`${VANILLA}Mallory has the following entity data: {pages: ["never closed`);
  await errOf(() => late);
  clock += 9000;
  check(say(`${VANILLA}Stopping the server`) === '' && s.state === 'running', 'a stalled answer holds for its time');
  clock += 2000;
  check(say(`${VANILLA}Stopping the server`) !== '' && s.state === 'stopping', 'and then the stream counts as lines again, so the server cannot go deaf');
  s.end();
}
{
  // A value the scanner cannot be fooled about, and one it was never meant for.
  const t = served();
  const q = t.session.query('data get entity Mallory', matchData('Mallory'), 2000);
  const shown = t.say(`${VANILLA}Mallory has the following entity data: {a: 1`);
  check(shown === '' && (await errOf(async () => parseSnbt(await q)))?.code === 'damaged', 'an answer that ends with its brackets open is a damaged answer, not a stuck one');
  check(t.say(`${VANILLA}Saving`) === `${VANILLA}Saving\n`, 'and the next line is a line');
  const colored = t.session.query('data get entity Mallory', matchData('Mallory'), 2000);
  t.session.filter(`\x1b[32m[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Mallory has the following entity data: {pages: ["one\ntwo"]}\x1b[0m\r\n`, 'out');
  check(parseSnbt(await colored).pages[0] === 'one\ntwo', 'a colored answer over two lines: the reset code at its end is no part of the value');
  const chat = t.session.query('data get entity Mallory', matchData('Mallory'), 30);
  const forged = `${VANILLA}<Mallory> Mallory has the following entity data: {"`;
  check(t.say(forged) === `${forged}\n`, 'chat cannot open an answer');
  await errOf(() => chat);
  check(t.say(`${VANILLA}Alice left the game`) !== undefined && namesOn(t) === 'Mallory', 'so the lines after it still count');
  t.session.end();
}
{
  // The owner types `data get` into the console: not a query, the same print.
  const t = served();
  const lines = [`Mallory has the following entity data: ${BOOKS[0][1](forgery(VANILLA))}`, `1, 64, -3 has the following block data: {Book: {id: "minecraft:written_book", tag: {pages: [${javaQuote(forgery(PAPER))}]}}}`,
    `Storage minecraft:x has the following contents: {a: ${javaQuote(forgery(VANILLA))}}`,
    // An entity that is no player prints its type or its custom name, which can be any text.
    `Armor Stand has the following entity data: {ArmorItems: [{id: "minecraft:written_book", Count: 1b, tag: {pages: [${javaQuote(forgery(VANILLA))}]}}, {}, {}, {}]}`,
    `Bob's [Shop]: open 9-5 has the following entity data: {Item: {id: "minecraft:writable_book", Count: 1b, tag: {pages: [${javaQuote(forgery(PAPER))}]}}}`];
  // A custom name can start like chat. Nobody online could have said these, and chat is one line, so they are answers.
  const held = (page) => `has the following entity data: {Item: {id: "minecraft:writable_book", Count: 1b, tag: {pages: [${javaQuote(page)}]}}}`;
  for (const name of ['<Bob> hi', '[Not Secure] <Bob> hi', '* Bob waves', '[Shop] open', '[] x']) lines.push(`${name} ${held(forgery(VANILLA))}`);
  for (const line of lines) {
    const text = `${VANILLA}${line}\n`;
    check(t.session.filter(text, 'out') === text, `the console keeps what it was asked for: ${line.slice(0, 40)}`);
    check(t.session.state === 'running' && namesOn(t) === 'Alice,Mallory', `and it forges nothing: ${line.slice(0, 40)}`);
  }
  const busy = t.session.query('data get entity Alice Pos', matchData('Alice'), 2000);
  const text = `${VANILLA}Mallory has the following entity data: ${BOOKS[1][1](forgery(VANILLA))}\n`;
  check(t.session.filter(text, 'out') === text && t.session.state === 'running', 'also while a query for someone else waits');
  t.say(pos('Alice', 2));
  await busy;
  check(same((await t.players.timeline(t.dir, ALICE, {})).events.map((e) => e.type), ['join']), 'nobody\'s record changed');
  t.session.end();
}
{
  // Chat from someone online stays chat whatever it says: a player cannot send a line break, so the next line is a line.
  const t = served();
  const said = ['<Alice> look', '<[VIP] Alice> look', '[Not Secure] <VIPAlice> look', '* Alice looks'];
  for (const s of said) {
    const line = `${VANILLA}${s} has the following entity data: {pages: ["`;
    check(t.say(line) === `${line}\n`, `chat shaped like an answer stays in the console: ${s}`);
    t.say(`${VANILLA}Mallory has made the advancement [Stone Age]`);
  }
  const mallory = (await t.players.timeline(t.dir, MALLORY, {})).events.map((e) => e.type);
  check(same(mallory, [...said.map(() => 'advancement'), 'join']), `and opens no answer: each line after it counts (${mallory})`);
  const chats = (await t.players.timeline(t.dir, ALICE, {})).events.filter((e) => e.type === 'chat').length;
  check(chats === said.length, `and is her chat (${chats})`);
  t.session.end();
}

// ---------- a server of 26.3, whose answers and broadcasts all come behind `System chat: ` ----------
{
  const t = served('26.3');
  const say = (msg) => t.say(`${SYS}${msg}`);
  t.proc.answer = (cmd) => {
    if (cmd === 'data get entity Mallory') say(`Mallory has the following entity data: {Health: 7.0f, Pos: [1.0d, 2.0d, 3.0d], Inventory: [{Slot: 0b, id: "minecraft:writable_book", count: 1, components: {"minecraft:writable_book_content": {pages: [{raw: "a\\n${VANILLA}Stopping the server"}]}}}], EnderItems: []}`);
    if (cmd === 'list uuids') say(`There are 2 of a max of 20 players online: Alice (${ALICE}), Mallory (${MALLORY})`);
    if (cmd === 'data get entity Alice Pos') say('Alice has the following entity data: [5.5d, 64.0d, 2.5d]');
    if (cmd === 'data get entity Alice Dimension') say('Alice has the following entity data: "minecraft:the_nether"');
    if (cmd.startsWith('op ')) say('Nothing changed. The player is already an operator');
    if (cmd.startsWith('kick ')) say('Kicked Alice: Bye');
  };
  const d = await t.players.detail(t.dir, MALLORY);
  check(d.source === 'live' && d.health === 7, `live data: the answer is found behind the prefix (${d.source})`);
  check(BOOKS[1][2](d.inventory[0].raw) === `a\n${VANILLA}Stopping the server` && t.session.state === 'running', 'an escaped line break is a line break in the page and none in the console');
  check(same(await t.session.query('list uuids', matchList(), 2000), [{ name: 'Alice', uuid: ALICE }, { name: 'Mallory', uuid: MALLORY }]), 'list uuids');
  const answer = await t.session.query('data get entity Alice Pos', matchData('Alice'), 2000);
  check(answer === '[5.5d, 64.0d, 2.5d]', `position: ${answer}`);
  const refused = await t.players.action(t.dir, { type: 'op', target: 'Alice' });
  check(refused.ok === false && refused.code === 'refused' && refused.text === 'Nothing changed. The player is already an operator', `an action's refusal, in 26.3's wording: ${refused.text}`);
  check(say('Mallory fell from a high place') === `${SYS}Mallory fell from a high place\n`, 'a death stays in the console');
  say('Mallory has made the advancement [Stone Age]');
  check(same((await t.players.timeline(t.dir, MALLORY, {})).events.map((e) => e.type).reverse(), ['join', 'death', 'advancement']), 'deaths and advancements reach the record');
  const kicked = await t.players.action(t.dir, { type: 'kick', target: 'Alice', reason: 'Bye' });
  check(kicked.ok === true && kicked.text === 'Kicked Alice: Bye', 'an action\'s answer');
  say('Alice left the game');
  check(namesOn(t) === 'Mallory', 'a leave');
  t.proc.answer = null;
  const open = t.session.query('data get entity Mallory', matchData('Mallory'), 2000);
  say(`Mallory has the following entity data: ${BOOKS[1][1](forgery(VANILLA))}`);
  check(BOOKS[1][2](parseSnbt(await open).Inventory[0]) === forgery(VANILLA) && t.session.state === 'running', 'a raw line break behind the prefix is still read to its end');
  t.session.end();
}

// ---------- answers by shape ----------
{
  const STRAY = ['Disconnecting com.mojang.authlib.GameProfile@1a2b3c[id=<null>,name=Stranger,properties={},legacy=false] (/203.0.113.77:50123): Failed to verify username!',
    'com.mojang.authlib.GameProfile@1a2b3c[id=<null>,name=Stranger] (/203.0.113.77:50123) lost connection: Disconnected', 'Disconnecting Stranger (/203.0.113.77:50123)', 'Stranger[/203.0.113.77:50123] tried to log in', 'Saved the game'];
  for (const [p, label] of [[VANILLA, 'vanilla'], [PAPER, 'paper']]) {
    const t = served();
    let wait = 0;
    t.proc.answer = (cmd) => { if (cmd.startsWith('op ')) { for (const s of STRAY) t.say(`${p}${s}`); t.say(`${p}Nothing changed. The player already is an operator`); } };
    const refused = await t.players.action(t.dir, { type: 'op', target: 'Mallory' });
    check(refused.ok === false && refused.code === 'refused' && refused.text === 'Nothing changed. The player already is an operator', `${label}: stray lines before the answer are not the answer: ${refused.text}`);
    t.proc.answer = (cmd) => { if (cmd.startsWith('deop ')) { wait = Date.now(); for (const s of STRAY) t.say(`${p}${s}`); } };
    const quiet = await t.players.action(t.dir, { type: 'deop', target: 'Mallory' });
    check(quiet.ok === true && quiet.code === 'noAnswer' && quiet.text === '', `${label}: stray lines and no answer: sent, no text (${quiet.text})`);
    check(Date.now() - wait >= 1000, `${label}: and they did not end the wait`);
    await t.players.adminLog(t.dir);
    const log = readFileSync(path.join(t.dir, '.nano', 'players', 'admin.jsonl'), 'utf8');
    check(!log.includes('203.0.113.77') && !log.includes('50123'), `${label}: no stray address reaches the admin log`);
    t.session.end();
  }
  const t = served();
  const stay = `${VANILLA}Saved the game`;
  t.proc.answer = (cmd) => { if (cmd.startsWith('kick ')) { check(t.say(stay) === `${stay}\n`, 'a stray line stays in the console'); t.say(`${VANILLA}Kicked Mallory: Bye`); } };
  const kicked = await t.players.action(t.dir, { type: 'kick', target: 'Mallory', reason: 'Bye' });
  check(kicked.ok === true && kicked.text === 'Kicked Mallory: Bye' && kicked.code === undefined, 'the real answer follows it');
  t.session.end();
}

// ---------- addresses in every stored path ----------
{
  const masked = (s) => { const m = maskAddresses(s); check(m === maskAddresses(m), `masking is stable: ${s}`); return m; };
  for (const [s, want] of [['203.0.113.77', '203.0.*.*'], ['/203.0.113.77:50123', '/203.0.*.*'], ['Banned IP 203.0.113.77.', 'Banned IP 203.0.*.*.'], ['(203.0.113.77)', '(203.0.*.*)'], ['a 1.2.3.4, b 5.6.7.8', 'a 1.2.*.*, b 5.6.*.*'],
    ['[2001:db8:1:2:3:4:5:6]:51234', '2001:db8:*'], ['/[2001:db8::3]:51234', '/2001:db8:*'], ['2001:db8::3', '2001:db8:*'], ['fe80::1%eth0', 'fe80:0:*'], ['::ffff:8.8.4.4', '::ffff:8.8.*.*'], ['::1', '*'], ['from 2001:db8::3.', 'from 2001:db8:*.'],
    // What is no address stays what it is.
    ['12:00:00', '12:00:00'], ['2026-10-30T12:00:00.000Z', '2026-10-30T12:00:00.000Z'], ['1.21.4', '1.21.4'], ['1.2.3.4.5', '1.2.3.4.5'], ['-3.25, 64.0, 10.5', '-3.25, 64.0, 10.5'], ['std::cout', 'std::cout'], ['a :: b', 'a :: b'], ['minecraft:stone', 'minecraft:stone'], ['1.2.*.*', '1.2.*.*'], ['2001:db8:*', '2001:db8:*']]) {
    check(masked(s) === want, `mask ${s} -> ${masked(s)}`);
  }
  const OP = new Set(['Steve']);
  const ban = parseLine(`${PAPER}Steve issued server command: /ban-ip 203.0.113.77 griefing`, OP);
  check(ban.text === '/ban-ip 203.0.*.* griefing', `a ban-ip command keeps no address: ${ban.text}`);
  const banned = parseLine(`${VANILLA}[Steve: Banned IP 203.0.113.77: griefing]`, OP);
  check(banned.text === 'Banned IP 203.0.*.*: griefing', `the operator's line neither: ${banned.text}`);
  check(parseLine(`${VANILLA}<Bob> my server is at 203.0.113.77:25565`, OP).text === 'my server is at 203.0.*.*', 'an address in chat is masked as well');
  check(parseLine(`${VANILLA}Steve lost connection: Internal Exception from /203.0.113.77:1`, OP).text === 'Internal Exception from /203.0.*.*', 'and in a leave');
  // 501 + a space + ten characters is the 512 the cap keeps, which ends the text at 203.0.113.
  const cut = parseLine(`${VANILLA}<Bob> ${'x'.repeat(501)} 203.0.113.77`, OP).text;
  check(cut.length <= 512 && !cut.includes('203.0.113'), `the length cap cannot leave three parts of an address: ${cut.slice(-12)}`);

  const dir = freshDir();
  const store = createStore(dir, { flushMs: 5 });
  await store.open();
  const entry = { action: { type: 'kick', target: 'Bob', reason: 'from 203.0.113.77' }, commands: ['kick Bob from 203.0.113.77'], ok: true, text: 'Kicked Bob: from [2001:db8::3]:51234', extra: { deep: ['/198.51.100.9:7'] } };
  store.admin(entry);
  store.add({ type: 'command', name: 'Bob', uuid: BOB, text: '/ban-ip 203.0.113.77', other: '198.51.100.9' });
  await store.flush();
  const onDisk = readFileSync(path.join(store.folder, 'admin.jsonl'), 'utf8') + readFileSync(path.join(store.folder, `${BOB}.jsonl`), 'utf8');
  check(!/203\.0\.113|198\.51\.100|2001:db8::|51234/.test(onDisk), `no field of any entry reaches a file unmasked: ${onDisk.slice(0, 160)}`);
  check((await store.adminLog())[0].t && (await store.timeline(BOB)).events[0].t, 'times stay readable');
}

// ---------- the admin log keeps the result ----------
{
  const t = served();
  t.proc.answer = (cmd) => {
    if (cmd.startsWith('op ')) t.say(`${VANILLA}Nothing changed. The player already is an operator`);
    if (cmd.startsWith('kick ')) t.say(`${VANILLA}Kicked Mallory: Bye`);
  };
  await t.players.action(t.dir, { type: 'op', target: 'Mallory' });
  await t.players.action(t.dir, { type: 'kick', target: 'Mallory', reason: 'Bye' });
  await t.players.action(t.dir, { type: 'whisper', target: 'Mallory', text: '   ' });
  await t.players.action(t.dir, { type: 'effect', target: 'Mallory', effect: 'not valid!' });
  t.proc.answer = null;
  await t.players.action(t.dir, { type: 'deop', target: 'Mallory' });
  t.session.end();
  await t.players.action(t.dir, { type: 'op', target: 'Mallory' });
  const log = await t.players.adminLog(t.dir, { limit: 10 });
  check(same(log.map((e) => e.code ?? null).reverse(), ['refused', null, 'text', 'effect', 'noAnswer', 'notRunning']), `every entry keeps its result code: ${log.map((e) => e.code).reverse()}`);
}

// ---------- a depth the game allows ----------
{
  const nested = (n) => `${'{a:'.repeat(n)}1${'}'.repeat(n)}`;
  check(parseSnbt(nested(512)) !== undefined, 'SNBT 512 levels deep, the game\'s own limit, is read');
  check((await errOf(() => parseSnbt(nested(513))))?.code === 'damaged', 'one level more is not');
  const item = `{Inventory: [{Slot: 0b, id: "minecraft:stick", count: 1, components: {"minecraft:custom_data": ${nested(200)}}}], Health: 5.0f}`;
  check(detailOf(parseSnbt(item), { source: 'live' }).inventory[0].id === 'minecraft:stick', 'an item nested 200 deep leaves the player readable');
  let deep = Buffer.from([0]);
  for (let i = 0; i < 500; i++) deep = Buffer.concat([Buffer.from([10, 0, 0]), deep, Buffer.from([0])]);
  check(!!parseNbt(Buffer.concat([Buffer.from([10, 0, 0]), deep])), 'binary NBT 500 levels deep is read');
}

// ---------- a server deleted with its store still open ----------
{
  const gone = (dir) => !existsSync(dir);
  const players = createPlayers({ send: () => {}, describe: () => ({ version: '1.21.1', kind: 'paper', proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
  const quiet = freshDir();
  await players.timeline(quiet, STEVE, {});
  await players.list(quiet);
  const dirty = freshDir();
  const session = players.begin(dirty);
  const proc = new FakeProcess();
  session.attach(proc);
  const say = (l) => session.filter(`${l}\n`, 'out');
  say(`${VANILLA}Done (1.0s)! For help, type "help"`);
  join({ say });
  session.end();
  await players.timeline(dirty, STEVE, {});
  const last = players.begin(dirty);
  last.attach(new FakeProcess());
  last.filter(`${VANILLA}Done (1.0s)! For help, type "help"\n`, 'out');
  join({ say: (l) => last.filter(`${l}\n`, 'out') });
  rmSync(quiet, { recursive: true, force: true });
  rmSync(dirty, { recursive: true, force: true });
  players.closeAll();
  check(gone(quiet), 'quitting does not bring a deleted server\'s folder back');
  check(gone(dirty), 'nor when lines were still queued for it');

  const dir = freshDir();
  const store = createStore(dir, { flushMs: 1 });
  await store.open();
  store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'late' });
  store.touch(STEVE, 'Steve');
  rmSync(dir, { recursive: true, force: true });
  await store.flush();
  await sleep(10);
  check(gone(dir), 'nor does the timer\'s write');
  mkdirSync(dir, { recursive: true });
  await store.open();
  await store.flush();
  check(Object.keys(store.known()).length === 0 && !existsSync(path.join(store.folder, `${STEVE}.jsonl`)), 'a server made again under the name inherits nothing');

  const alive = freshDir();
  const kept = createStore(alive);
  await kept.open();
  kept.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'kept' });
  kept.flushSync();
  check(readFileSync(path.join(kept.folder, `${STEVE}.jsonl`), 'utf8').includes('kept'), 'a server that is there still gets its lines at quit');
  const fresh = freshDir();
  createStore(fresh).flushSync();
  check(!existsSync(path.join(fresh, '.nano')), 'and with nothing to write, no folder appears');
}

// ---------- the queue on a disk that refuses ----------
{
  const dir = freshDir();
  mkdirSync(path.join(dir, '.nano'), { recursive: true });
  writeFileSync(path.join(dir, '.nano', 'players'), 'a file where the folder should be');
  const store = createStore(dir, { flushMs: 100000 });
  store.add({ type: 'chat', name: 'Bob', uuid: BOB, text: 'one short file first' });
  for (let i = 0; i < 300000; i++) store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'x' });
  rmSync(path.join(dir, '.nano', 'players'));
  await store.flush();
  const kept = readFileSync(path.join(store.folder, `${STEVE}.jsonl`), 'utf8').split('\n').length - 1;
  check(kept <= 20000 && kept > 10000, `the queue's cap holds after its first file empties: ${kept} of 300000 lines kept`);
}

// ---------- search ----------
{
  const dir = freshDir();
  const store = createStore(dir, { flushMs: 100000 });
  await store.open();
  const folder = store.folder;
  const at = (i) => new Date(1700000000000 + i * 1000).toISOString();
  const event = (i, uuid, text, type = 'chat') => J({ t: at(i), type, name: uuid.slice(0, 4), uuid, text });
  const uuids = Array.from({ length: 6 }, (_v, n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`);
  const all = [];
  let seed = 7;
  const random = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
  const lines = new Map(uuids.map((u) => [u, []]));
  for (let i = 0; i < 12000; i++) {
    const uuid = uuids[random(uuids.length)];
    const e = { i, text: `${i % 3 ? 'plain' : '안녕 하세요'} ${i % 97 ? '' : 'rare'} ${'y'.repeat(random(200))}`, type: i % 11 ? 'chat' : 'death', uuid };
    all.push(e);
    lines.get(uuid).push(event(i, uuid, e.text, e.type));
  }
  for (const [u, l] of lines) writeFileSync(path.join(folder, `${u}.jsonl`), `${l.join('\n')}\n`);
  writeFileSync(path.join(folder, `${uuids[0]}.jsonl`), `${readFileSync(path.join(folder, `${uuids[0]}.jsonl`), 'utf8')}{"t":"torn`);
  const brute = (want, max) => all.filter(want).sort((a, b) => b.i - a.i).slice(0, max).map((e) => at(e.i));
  // The small limits end in each file's last block. A rare text has to cross all of them, every edge between two blocks.
  for (const [opts, want, max] of [[{ limit: 7 }, () => true, 7], [{}, () => true, 200], [{ limit: 1000 }, () => true, 1000], [{ q: 'rare', limit: 20 }, (e) => e.text.includes('rare'), 20],
    [{ q: 'rare', limit: 1000 }, (e) => e.text.includes('rare'), 1000], [{ q: '안녕', limit: 300 }, (e) => e.text.includes('안녕'), 300], [{ q: '안녕', limit: 1000 }, (e) => e.text.includes('안녕'), 1000],
    [{ types: ['death'], limit: 50 }, (e) => e.type === 'death', 50], [{ types: ['death'], limit: 1000 }, (e) => e.type === 'death', 1000], [{ q: 'no such text' }, () => false, 200]]) {
    const got = (await store.search(opts)).map((e) => e.t);
    check(same(got, brute(want, max)), `search ${J(opts)}: the newest ${got.length} across files, in order`);
  }
  check((await store.search({ limit: 12000 })).length === 1000, 'a limit stays clamped');
  {
    // Every character is three bytes, so a block's edge falls inside one unless lines are cut at the byte.
    const wide = freshDir();
    const korean = createStore(wide);
    await korean.open();
    const text = '안'.repeat(100);
    writeFileSync(path.join(korean.folder, `${STEVE}.jsonl`), Array.from({ length: 1000 }, (_v, i) => `${event(i, STEVE, text)}\n`).join(''));
    const read = await korean.search({ limit: 1000 });
    check(read.length === 1000 && read.every((e, i) => e.text === text && e.t === at(999 - i)), `lines over ${statSync(path.join(korean.folder, `${STEVE}.jsonl`)).size >> 16} block edges come back whole`);
  }

  // A search reads the end of each file, and a search that was replaced stops.
  const realOpen = fs.promises.open;
  let opened = 0;
  let reads = 0;
  fs.promises.open = async (...args) => {
    const handle = await realOpen.apply(fs.promises, args);
    opened++;
    const read = handle.read.bind(handle);
    handle.read = (...a) => { reads++; return read(...a); };
    return handle;
  };
  try {
    await store.search({ limit: 20 });
    check(reads <= 2 * uuids.length, `the default search stops early: ${reads} blocks of ${uuids.length} files`);
    opened = 0;
    reads = 0;
    const eight = await Promise.all(Array.from({ length: 8 }, (_v, n) => store.search({ q: n === 7 ? 'rare' : 'plain', limit: 5 })));
    check(eight.every((r) => same(r, eight[7])) && eight[7].every((e) => e.text.includes('rare')), 'asking again while one runs: everyone gets the newest request\'s answer');
    check(opened <= uuids.length * 2, `eight searches at once run at most twice over: ${opened} files opened`);
  } finally { fs.promises.open = realOpen; }

  const big = freshDir();
  const huge = createStore(big);
  await huge.open();
  writeFileSync(path.join(huge.folder, `${STEVE}.jsonl`), Array.from({ length: 200000 }, (_v, i) => `${event(i, STEVE, 'hello')}\n`).join(''));
  const found = await errOf(async () => { check((await huge.search({ limit: 3 })).length === 3, 'a 200000 line file searches'); });
  check(found === null, `and does not overflow the stack: ${found?.message ?? 'no error'}`);
  check(same(await createStore(freshDir()).search({}), []), 'a server with no records searches to nothing');
}

// ---------- the real launch() against a stand-in for a JVM on Korean Windows ----------
{
  process.env.PYIDE_TRUST_ALL = '1';
  const javaHome = freshDir();
  mkdirSync(path.join(javaHome, 'bin'));
  writeFileSync(path.join(javaHome, 'bin', 'java.exe'), '');
  process.env.PYIDE_MC_JAVA = javaHome;
  const load = Module._load;
  const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => work, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : {}) });
  Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
  const feature = require('../main/features/minecraft.js');
  Module._load = load;
  const handlers = new Map();
  feature.register({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, send() {}, startProcess() {}, procs: new Map(), diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
  check(handlers.has('players:names'), 'players:names is a channel');
  const server = (desc) => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'pyide-server.json'), J({ kind: 'paper', mc: '1.21.1', java: 21, memory: '2G', launch: { jar: 'server.jar' }, ...desc }));
    return dir;
  };
  const launch = (dir) => handlers.get('minecraft:launch')({}, path.dirname(dir), dir, 'job', {});
  const WANT = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dstdin.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8'];
  const plain = await launch(server({}));
  const own = await launch(server({ jvmArgs: ['-XX:+UseSerialGC'] }));
  const none = await launch(server({ jvmArgs: [] }));
  const proxy = await launch(server({ kind: 'velocity', jvmArgs: undefined }));
  for (const [label, spec] of [['the default flags', plain], ['jvmArgs of its own', own], ['jvmArgs: []', none], ['a proxy', proxy]]) check(WANT.every((f) => spec.args.includes(f)), `launch() sets the encodings with ${label}`);
  const before = (spec) => spec.args.indexOf('-Dfile.encoding=UTF-8') < spec.args.indexOf('-jar');
  check(before(plain) && before(own), 'and they are options of the JVM, before the jar');
  const line = (spec) => spec.args.join(' ');
  check(/-Xmx2G -XX:\+UseG1GC .*-XX:G1NewSizePercent=30 .*-XX:MaxTenuringThreshold=1 /.test(line(plain)), 'verify/minecraft.mjs still finds -Xmx next to the GC options');
  const forge = server({ kind: 'forge', launch: { argsFile: 'libraries/forge/win_args.txt' }, jvmArgs: ['-XX:+UseSerialGC'] });
  writeFileSync(path.join(forge, 'user_jvm_args.txt'), '');
  check(/-Xmx2G -XX:\+UseSerialGC @user_jvm_args\.txt @libraries\/forge\/win_args\.txt nogui$/.test(line(await launch(forge))), 'and the Forge line unbroken');

  const standIn = path.join(work, 'jvm-stand-in.cjs');
  writeFileSync(standIn, `
const iconv = require(${J(require.resolve('iconv-lite'))});
const flag = (name) => process.argv.find((a) => a.startsWith('-D' + name + '='))?.slice(name.length + 3);
const out = flag('stdout.encoding') ?? 'ms949';
const input = flag('file.encoding') ?? 'ms949';
const say = (text) => process.stdout.write(iconv.encode('[12:00:00 INFO]: ' + text + '\\n', out));
say('Done (1.0s)! For help, type "help"');
say('Steve[/1.2.3.4:5] logged in with entity id 1 at ([world]1.0, 2.0, 3.0)');
say('Steve joined the game');
say('<Steve> 안녕하세요');
let rest = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  rest = Buffer.concat([rest, d]);
  for (let nl = rest.indexOf(10); nl !== -1; nl = rest.indexOf(10)) {
    const line = iconv.decode(rest.subarray(0, nl), input).trim();
    rest = rest.subarray(nl + 1);
    const m = /^msg (\\S+) (.*)$/.exec(line);
    if (m) say('You whisper to ' + m[1] + ': ' + m[2]);
    if (line === 'stop') process.exit(0);
  }
});
`);
  const iconv = require('iconv-lite');
  const run = async (args) => {
    const dir = freshDir();
    const players = createPlayers({ send: () => {}, describe: () => ({ version: '1.21.1', kind: 'paper', proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
    const session = players.begin(dir);
    const child = spawn(process.execPath, [standIn, ...args], { windowsHide: true });
    const decoder = iconv.getDecoder('utf8');
    child.stdout.on('data', (d) => session.filter(decoder.write(d), 'out'));
    session.attach(child);
    await waitFor(() => session.players().length === 1, 5000);
    await waitFor(async () => (await players.timeline(dir, offlineUuid('Steve'), { types: ['chat'] })).events.length === 1, 5000);
    const chat = (await players.timeline(dir, offlineUuid('Steve'), { types: ['chat'] })).events[0]?.text;
    const whispered = await players.action(dir, { type: 'whisper', target: 'Steve', text: '차단 사유' });
    child.stdin.write('stop\n');
    await new Promise((r) => { child.on('close', r); });
    await sleep(5);
    return { chat, whisper: whispered.text };
  };
  const good = await run(plain.args);
  check(good.chat === '안녕하세요', `with launch()'s arguments Korean chat is stored whole: ${good.chat}`);
  check(good.whisper === 'You whisper to Steve: 차단 사유', `and a Korean whisper gets through stdin and back: ${good.whisper}`);
  const bad = await run(['-Xmx2G']);
  check(bad.chat?.includes('�'), `control: without them the stand-in damages the chat, so this can fail: ${bad.chat}`);
  check(bad.whisper !== good.whisper, `control: and the whisper: ${bad.whisper}`);
}

// ---------- moving items, through the session, against the game's rules ----------
{
  const SYSTEM = `${VANILLA}System chat: `;
  const stage = (version, stacks, kind = 'paper') => {
    const dir = serverDir();
    const pushes = [];
    const players = createPlayers({ send: (ch, p) => pushes.push(p), describe: () => ({ version, kind, proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
    const session = players.begin(dir);
    const proc = new FakeProcess();
    session.attach(proc);
    const shown = [];
    const say = (line) => { shown.push(session.filter(`${line}\n`, 'out')); };
    say(`${VANILLA}Done (1.0s)! For help, type "help"`);
    join({ say });
    const game = createGame({ version, name: 'Steve', stacks });
    const t = { dir, players, session, proc, say, shown, game, between: null, silent: false };
    proc.answer = (text) => {
      for (const line of text.split('\n')) {
        if (t.silent) continue;
        if (line === 'data get entity Steve') say(`${SYSTEM}Steve has the following entity data: ${game.data()}`);
        else for (const said of game.run(line) ?? []) say(`${SYSTEM}${said}`);
        t.between?.(line);
      }
    };
    return t;
  };
  const SWORD = { id: 'minecraft:diamond_sword', count: 1, extra: 'components: {"minecraft:damage": 12}' };
  const DIRT = { id: 'minecraft:dirt', count: 32 };
  const printAt = (d, n) => slotIn(d, n)?.print ?? null;

  {
    const t = stage('26.3', { 0: SWORD, 9: DIRT });
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    check(d.source === 'live' && /^[0-9a-f]{40}$/.test(printAt(d, 0)), 'a live detail holds each stack\'s print');
    const moved = { type: 'moveItem', target: 'Steve', op: 'move', from: 0, to: 1, shown: { from: printAt(d, 0), to: null } };
    t.proc.written.length = 0;
    const r = await t.players.action(t.dir, moved);
    check(r.ok && !r.code, `a move works: ${J(r)}`);
    check(t.proc.written.length === 2, `a read before, and all the lines in one write: ${t.proc.written.length} writes`);
    check(t.proc.written[1].split('\n').filter(Boolean).length === 6, 'the write holds the steps, their record and the read');
    check(t.game.held.get(1)?.extra === SWORD.extra && !t.game.held.has(0), 'the stack is in its new slot with its data');
    check(r.commands.length === 6 && r.text.includes('Replaced 1 slot(s) on Steve'), 'the result has the lines and the answers');
    const console = t.shown.join('');
    check(console.includes('Replaced 1 slot(s) on Steve') && !console.includes('has the following entity data'), 'the answers stay in the console and the reads do not');
    const log = await t.players.adminLog(t.dir);
    check(log.length === 1 && log[0].action.op === 'move' && !('shown' in log[0].action) && log[0].commands.length === 6 && log[0].ok, `one admin line with its commands: ${J(log)}`);

    t.proc.written.length = 0;
    const stale = await t.players.action(t.dir, moved);
    check(stale.code === 'changed' && stale.commands.length === 0 && t.proc.written.length === 1, `a slot that is not what the tab shows stops it after the read: ${J(stale)}`);
    check(t.game.held.has(1), 'and nothing moved');

    const d2 = await t.players.detail(t.dir, STEVE);
    t.proc.written.length = 0;
    t.between = (line) => { if (line.includes('from entity')) t.game.swap(1, 2); };
    const raced = await t.players.action(t.dir, { ...moved, from: 1, to: 3, shown: { from: printAt(d2, 1), to: null } });
    t.between = null;
    check(raced.code === 'mismatch' && raced.whole === true && !raced.ok, `a click between the lines is reported as it is: ${J(raced)}`);
    check(t.proc.written.length === 2, 'and nothing is sent again');
    check(t.game.held.has(2) && !t.game.held.has(3) && t.game.stacks().length === 2, `the spare copy went, so the stack is not doubled: ${t.game.all()}`);

    const d3 = await t.players.detail(t.dir, STEVE);
    const [a, b] = await Promise.all([t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'clear', from: 9, shown: { from: printAt(d3, 9) } }), t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'clear', from: 2, shown: { from: printAt(d3, 2) } })]);
    check([a.code, b.code].includes('busy'), `two moves at once: the second is refused: ${a.code} ${b.code}`);

    const left = await t.players.action(t.dir, { type: 'moveItem', target: 'Alex', op: 'clear', from: 9, shown: { from: printAt(d3, 9) } });
    check(left.code === 'offline' && !left.commands.length, 'a player who is not on');
    const bad = await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'move', from: 'x', to: 2 });
    check(bad.code === 'slot', 'a bad slot is a value');
  }
  {
    const t = stage('26.3', { 0: SWORD, 9: DIRT });
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    t.between = (line) => { if (line.includes('from entity')) t.game.held.delete(1); };
    const r = await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'move', from: 0, to: 1, shown: { from: printAt(d, 0), to: null } });
    t.between = null;
    check(r.code === 'mismatch' && r.whole === false && t.game.stacks().length === 1, `a stack lost in the move is reported: ${J(r)}`);
    check(!('changed' in r), 'the slots\' data stay out of what goes to the window');
    const [entry] = await t.players.adminLog(t.dir);
    const lost = entry.changed?.find((c) => c.slot === 0);
    check(lost?.before === '{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:damage": 12}}' && lost.after === null, `the admin log keeps the lost stack as the game printed it: ${J(entry.changed)}`);
    const quiet = await t.players.detail(t.dir, STEVE);
    await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'clear', from: 9, shown: { from: printAt(quiet, 9) } });
    const [plain] = await t.players.adminLog(t.dir);
    check(plain.ok && !('changed' in plain), 'a move that went right writes no slots');
  }
  {
    const t = stage('26.3', { 0: { id: 'somemod:robe_chestplate', count: 1 } });
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    t.game.refuses = (slot) => slot === 102;
    const r = await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'move', from: 0, to: 102, shown: { from: printAt(d, 0), to: null } });
    check(r.code === 'notMoved' && r.text.includes('No targets accepted') && t.game.held.has(0), `a refused copy leaves the item, and says nothing moved: ${J(r)}`);
  }
  {
    const full = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [i, { id: 'minecraft:dirt', count: i + 1 }]));
    const t = stage('1.20.1', full);
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    t.proc.written.length = 0;
    const r = await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'move', from: 0, to: 1, shown: { from: printAt(d, 0), to: printAt(d, 1) } });
    check(r.code === 'noRoom' && t.proc.written.length === 1, `a swap with no empty slot sends nothing: ${J(r)}`);
  }
  {
    const t = stage('26.3', { 0: SWORD });
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    t.between = (line) => { if (line.startsWith('execute')) { t.say(`${SYSTEM}No entity was found`); t.silent = true; } };
    const r = await t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'clear', from: 0, shown: { from: printAt(d, 0) } });
    check(r.code === 'unconfirmed' && r.commands.length === 2, `no read at the end is said plainly: ${J(r)}`);
    t.silent = false;
    t.between = null;
  }
  {
    const t = stage('26.3', { 0: SWORD });
    await sleep(5);
    const d = await t.players.detail(t.dir, STEVE);
    t.silent = true;
    const pending = t.players.action(t.dir, { type: 'moveItem', target: 'Steve', op: 'clear', from: 0, shown: { from: printAt(d, 0) } });
    await sleep(5);
    t.proc.emit('close');
    const r = await pending;
    check(r.code === 'stopped' && !r.commands.length, `a server gone during the first read: ${J(r)}`);
  }
}

// ---------- the bridge's lines ----------
{
  const UUID_OF = { [STEVE]: 'Steve' };
  const known = (uuid) => UUID_OF[uuid];
  const line = (o) => J({ v: 1, time: '2026-11-01T00:00:00.000Z', uuid: STEVE, type: 'break', world: 'world', x: 1, y: 2, z: 3, n: 1, id: 'minecraft:stone', ...o });
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  const parse = (o) => parseBridge(typeof o === 'string' ? o : line(o), known, { now });
  const good = parse({ n: 12, at: [[1, 2, 3], [2, 2, 3]] }).event;
  check(good?.type === 'break' && good.name === 'Steve' && good.n === 12 && good.at.length === 2 && good.time === '2026-11-01T00:00:00.000Z', `a good line: ${J(good)}`);
  check(parse({ name: 'Griefer' }).event.name === 'Steve', 'a name on the line is ignored: the store knows the name');
  const forged = parse({ type: 'hit', other: 'Alex', weapon: 'minecraft:bow', amount: 3.5, ip: '203.0.113.7', secure: true, why: 'x', text: 'forged' }).event;
  check(forged && !('ip' in forged) && !('secure' in forged) && !('why' in forged) && forged.text === '', `fields a type does not have are not copied: ${J(forged)}`);
  for (const type of ['chat', 'join', 'leave', 'death', 'advancement', 'command', 'server', '__proto__', 'constructor', 'hasOwnProperty']) check(parse({ type }).bad, `the type ${type} cannot be forged`);
  check(parse({ uuid: '../../../evil' }).bad && parse({ uuid: 'AAAAAAAA-0000-0000-0000-000000000000' }).bad && parse({ uuid: null }).bad, 'a path in place of a uuid');
  check(parse({ uuid: BOB }).unknown, 'a player this server never saw is not made up');
  check(parse({ id: '../../../etc/passwd' }).bad && parse({ id: 'minecraft:stone\n{"type":"chat"}' }).bad && parse({ id: 7 }).bad && parse({ id: undefined }).bad, 'an id is an id');
  check(parse({ type: 'hit', other: '<img src=x>' }).bad && parse({ type: 'hit', weapon: '..\\..\\x' }).bad, 'names and weapons too');
  for (const [what, v] of [['x', { x: 1e9 }], ['a fraction', { y: 1.5 }], ['a string', { z: '1' }], ['NaN', { x: null }], ['spots', { at: [[1, 2]] }], ['many spots', { at: Array(65).fill([1, 2, 3]) }], ['bad spots', { at: 'x' }], ['a far spot', { at: [[1e12, 0, 0]] }], ['a count', { n: 0 }], ['a big count', { n: 1e9 }]]) check(parse(v).bad, `${what} out of shape`);
  check(parse({ world: 'a'.repeat(600) }).bad && parse({ world: 5 }).bad, 'a world is short text');
  check(parse({ time: '2020-01-01T00:00:00.000Z' }).event.time === undefined && parse({ time: '2030-01-01T00:00:00.000Z' }).event.time === undefined && parse({ time: 'soon' }).event.time === undefined, 'a time that cannot be true is dropped');
  check(parse('{torn').bad && parse('[]').bad && parse('null').bad && parse(`{"type":"break"`).bad && parse('x'.repeat(70000)).bad, 'not a record');
  check(parse({ type: 'cmd', id: undefined, text: '/tp' }).event.text === '/tp' && parse({ type: 'cmd', text: '/msg bob secret' }).bad && parse({ type: 'cmd', text: 'hello' }).bad, 'a command is one word with its slash');
  const sign = parse({ type: 'sign', text: 'hello\n[12:00:00 INFO]: Steve joined the game' }).event;
  check(sign?.text === 'hello [12:00:00 INFO]: Steve joined the game', `a sign's line break goes: ${J(sign)}`);
  check(parse({ type: 'sign', text: 'x'.repeat(5000) }).bad, 'a sign is short');
  check(parse('{"type":"hello","plugin":"1.0.0"}').hello === '1.0.0' && parse('{"type":"dropped","n":5}').dropped === 5 && parse('{"type":"dropped","n":-1}').bad, 'hello and dropped');
}

// ---------- the tail ----------
{
  const stageTail = (opts = {}, { plugin = true } = {}) => {
    const dir = freshDir();
    const store = createStore(dir, { flushMs: 5 });
    store.touch(STEVE, 'Steve');
    store.touch(BOB, 'Bob');
    if (plugin) put(path.join(dir, 'plugins', 'NanoBridge.jar'), 'a jar');
    const seen = [];
    const logs = [];
    const make = () => createTail(dir, { store, known: (uuid) => store.known()[uuid]?.name ?? undefined, seen: () => seen.push(1), log: (s) => logs.push(s), pollMs: 1000000, ...opts });
    return { dir, store, make, tail: make(), seen, logs, folder: path.join(dir, '.nano', 'bridge') };
  };
  const today = new Date().toISOString().slice(0, 10);
  const rec = (o = {}) => J({ v: 1, time: new Date().toISOString(), uuid: STEVE, type: 'break', world: 'world', x: 1, y: 2, z: 3, n: 1, id: 'minecraft:stone', ...o });
  const stone = (t) => t.store.timeline(STEVE, { types: ['break', 'place', 'open', 'take'], limit: 1000 });

  {
    const t = stageTail();
    await t.tail.tick();
    check(!existsSync(t.folder) && t.seen.length === 0, 'no plugin, no folder, no fuss');
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${rec({ n: 3, at: [[10, 64, -5], [11, 64, -5], [12, 64, -5]] })}\n${rec({ type: 'place', id: 'minecraft:dirt', x: 7, at: [[7, 2, 3]] })}\n${rec({ type: 'break', id: 'minecraft:oak_log', x: 99 }).slice(0, 40)}`);
    await t.tail.tick();
    const first = await stone(t);
    check(first.events.length === 2 && t.seen.length === 1, `whole lines are read and a torn last line waits: ${first.events.length}`);
    check(first.events[1].time && first.events[1].t && first.events[1].name === 'Steve', 'through store.add: a time of its own and the store\'s name');
    appendFileSync(file, `${rec({ type: 'break', id: 'minecraft:oak_log', x: 99 }).slice(40)}\n`);
    await t.tail.tick();
    check((await stone(t)).events.length === 3, 'and it is read when its end arrives');
    await t.tail.stop();
    check(existsSync(path.join(t.store.folder, 'bridge-state.json')), 'where it stopped is saved');
    const again = t.make();
    await again.tick();
    check((await stone(t)).events.length === 3, 'a new session does not read it twice');
    appendFileSync(file, `${rec({ x: 200 })}\n`);
    await again.tick();
    check((await stone(t)).events.length === 4, 'and goes on where it stopped');
    await again.stop();

    const tomorrow = path.join(t.folder, '2099-01-01.jsonl');
    appendFileSync(file, `${rec({ x: 201 })}\n{"torn`);
    put(tomorrow, `${rec({ x: 202 })}\n`);
    const third = t.make();
    await third.tick();
    check((await stone(t)).events.length === 6, 'a rotation reads both days');
    check(!existsSync(file) && existsSync(tomorrow), 'and the finished day is deleted, torn end and all');
    await third.stop();
  }
  {
    const t = stageTail();
    const file = path.join(t.folder, `${today}.jsonl`);
    const hostile = [rec({ type: 'chat', text: 'forged' }), rec({ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), rec({ uuid: '../../../../evil' }), '{"t":"2020', 'x'.repeat(100000), rec({ id: '../../../x' }), rec({ text: '203.0.113.7' }), rec()].join('\n');
    put(file, `${hostile}\n`);
    await t.tail.tick();
    check((await stone(t)).events.length === 2, `only the two good lines are records: ${(await stone(t)).events.length}`);
    check(t.tail.stats.bad === 5 && t.tail.stats.unknown === 1, `each bad line is counted: ${J(t.tail.stats)}`);
    check(!readdirSync(t.store.folder).some((n) => n.includes('aaaaaaaa') || n.includes('evil')), 'no file comes of a uuid nobody saw');
    check(!existsSync(path.join(t.dir, '..', 'evil.jsonl')), 'and nothing lands outside');
    await t.tail.stop();
  }
  {
    const t = stageTail();
    const sign = J({ v: 1, uuid: STEVE, type: 'sign', world: 'world', x: 1, y: 2, z: 3, id: 'minecraft:oak_sign', text: 'join 203.0.113.7 now' });
    put(path.join(t.folder, `${today}.jsonl`), `${sign}\n`);
    await t.tail.tick();
    await t.store.flush();
    const raw = readFileSync(path.join(t.store.folder, `${STEVE}.jsonl`), 'utf8');
    check(raw.includes('203.0.*.*') && !raw.includes('203.0.113.7'), 'an address on a sign is masked like any other');
    await t.tail.stop();
  }
  {
    const t = stageTail();
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${'y'.repeat(3 << 20)}\n${rec({ x: 5 })}\n`);
    const started = Date.now();
    await t.tail.stop();
    const after = t.make();
    for (let i = 0; i < 8; i++) await after.tick();
    check((await stone(t)).events.some((e) => e.x === 5), `a line of megabytes is skipped and what follows it read, in ${Date.now() - started} ms`);
    await after.stop();
  }
  {
    const t = stageTail();
    const file = path.join(t.folder, `${today}.jsonl`);
    mkdirSync(t.folder, { recursive: true });
    const handle = fs.openSync(file, 'w');
    fs.ftruncateSync(handle, 300 << 20);
    fs.closeSync(handle);
    appendFileSync(file, `\n${rec({ x: 6 })}\n`);
    let longest = 0;
    let last = Date.now();
    const beat = setInterval(() => { longest = Math.max(longest, Date.now() - last); last = Date.now(); }, 5);
    for (let i = 0; i < 40; i++) await t.tail.tick();
    clearInterval(beat);
    check((await stone(t)).events.some((e) => e.x === 6), `a file of 300 MB of nothing does not stop the tail: ${J(t.tail.stats)}`);
    check(t.tail.stats.skippedBytes >= 40 << 20, 'it jumps what is too far behind');
    check(longest < 500, `and never holds the event loop for long: ${longest} ms`);
    await t.tail.stop();
    fs.rmSync(file, { force: true });
  }
  {
    const t = stageTail();
    const outside = freshDir();
    put(path.join(outside, `${today}.jsonl`), `${rec({ x: 666 })}\n`);
    mkdirSync(path.join(t.dir, '.nano'), { recursive: true });
    fs.symlinkSync(outside, t.folder, 'junction');
    await t.tail.tick();
    check((await stone(t)).events.length === 0 && t.logs.some((l) => l.includes('leads out')), 'a junction out of the server is not followed');
    check(existsSync(path.join(outside, `${today}.jsonl`)), 'and nothing is deleted there');
    await t.tail.stop();
  }
  {
    const t = stageTail();
    const old = path.join(t.folder, '2001-01-01.jsonl');
    put(old, `${rec({ x: 1 })}\n`);
    put(path.join(t.folder, 'notes.txt'), 'keep');
    put(path.join(t.folder, '..', 'bridge', '2026-13.jsonl'), `${rec()}\n`);
    put(path.join(t.folder, `${today}.jsonl`), `${rec({ x: 2 })}\n`);
    await t.tail.tick();
    check(!existsSync(old) && (await stone(t)).events.length === 1, 'a file past the retention is deleted unread');
    check(existsSync(path.join(t.folder, 'notes.txt')) && existsSync(path.join(t.folder, '2026-13.jsonl')), 'and what is not one of its files is left alone');
    await t.tail.stop();
  }
}

// ---------- the tail: reads that fail, tails in a row, a plugin that is gone ----------
{
  const stageTail = ({ plugin = true } = {}) => {
    const dir = freshDir();
    const store = createStore(dir, { flushMs: 5 });
    store.touch(STEVE, 'Steve');
    if (plugin) put(path.join(dir, 'plugins', 'NanoBridge.jar'), 'a jar');
    const logs = [];
    const make = (opts) => createTail(dir, { store, known: (uuid) => store.known()[uuid]?.name ?? undefined, log: (s) => logs.push(s), pollMs: 1000000, ...opts });
    return { dir, store, make, logs, folder: path.join(dir, '.nano', 'bridge') };
  };
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const rec = (o = {}) => J({ v: 1, time: new Date().toISOString(), uuid: STEVE, type: 'break', world: 'world', x: 1, y: 2, z: 3, n: 1, id: 'minecraft:stone', ...o });
  const stored = async (t) => {
    await t.store.flush();
    const file = path.join(t.store.folder, `${STEVE}.jsonl`);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"break"')).length : 0;
  };
  const failOnce = (name, match, code = 'EMFILE') => {
    const real = fs.promises[name];
    let left = 1;
    fs.promises[name] = (...args) => {
      if (left && match(String(args[0]))) { left--; throw Object.assign(new Error(code), { code }); }
      return real.apply(fs.promises, args);
    };
    return () => { fs.promises[name] = real; };
  };

  {
    const t = stageTail();
    const older = path.join(t.folder, `${yesterday}.jsonl`);
    put(older, `${rec({ x: 1 })}\n${rec({ x: 2 })}\n${rec({ x: 3 })}\n`);
    put(path.join(t.folder, `${today}.jsonl`), `${rec({ x: 4 })}\n`);
    const tail = t.make();
    const restore = failOnce('open', (f) => f.endsWith(`${yesterday}.jsonl`));
    await tail.tick();
    restore();
    check(existsSync(older), 'an older file that could not be read is not deleted');
    check(t.logs.some((l) => l.includes('EMFILE')), 'and the error is logged');
    await tail.tick();
    check(await stored(t) === 4 && !existsSync(older), `and the next pass reads it, then deletes it: ${await stored(t)} of 4`);
    await tail.stop();
  }
  {
    const t = stageTail();
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${rec({ x: 1 })}\n`);
    const first = t.make();
    await first.tick();
    await first.stop();
    appendFileSync(file, `${rec({ x: 2 })}\n`);
    const second = t.make();
    const restore = failOnce('readFile', (f) => f.endsWith('bridge-state.json'));
    await second.tick();
    restore();
    await second.tick();
    check(await stored(t) === 2, `a state file that could not be read now does not start the file over: ${await stored(t)} of 2`);
    await second.stop();
  }
  {
    const t = stageTail();
    put(path.join(t.folder, `${today}.jsonl`), `${rec()}\n`);
    const tail = t.make();
    const [a, b] = [tail.stop(), tail.stop()];
    check(a === b, 'stopping twice is one stop');
    await a;
    check(await stored(t) === 1, 'and its passes ran once');
  }
  {
    const t = stageTail();
    put(path.join(t.folder, `${today}.jsonl`), Array.from({ length: 3000 }, (_, i) => rec({ x: i })).join('\n') + '\n');
    const old = t.make();
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const late = t.make({ after: gate.then(() => old.stop()) });
    const pending = late.tick();
    await sleep(30);
    check(await stored(t) === 0, 'a tail waits for the one before it');
    open();
    await pending;
    await late.stop();
    check(await stored(t) === 3000, `and takes over from where it stopped: ${await stored(t)} of 3000`);
  }
  for (const [what, end] of [['a server that stopped', (s) => s.end()], ['a server that has not ended yet', () => {}]]) {
    const dir = freshDir();
    put(path.join(dir, 'plugins', 'NanoBridge.jar'), 'a jar');
    const players = createPlayers({ send: () => {}, describe: () => ({ version: '26.3', kind: 'paper', proxy: false }), sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 }, tailOptions: { pollMs: 1 } });
    const store = createStore(dir, { flushMs: 5 });
    store.touch(STEVE, 'Steve');
    await store.flush();
    put(path.join(dir, '.nano', 'bridge', `${today}.jsonl`), Array.from({ length: 3000 }, (_, i) => rec({ x: i })).join('\n') + '\n');
    const first = players.begin(dir);
    first.attach(new FakeProcess());
    await sleep(1);
    end(first);
    const second = players.begin(dir);
    second.attach(new FakeProcess());
    await sleep(120);
    first.end();
    second.end();
    await sleep(120);
    const file = path.join(dir, '.nano', 'players', `${STEVE}.jsonl`);
    const n = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"break"')).length : 0;
    check(n === 3000, `a new tail after ${what} counts each line once: ${n} of 3000`);
  }

  {
    const t = stageTail({ plugin: false });
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${rec({ x: 1 })}\n${rec({ x: 2 })}\n`);
    const tail = t.make();
    await tail.tick();
    check(await stored(t) === 2 && !existsSync(file), 'without the plugin the last day\'s file is read, then deleted');
    await tail.stop();
  }
  {
    const t = stageTail({ plugin: true });
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${rec({ x: 1 })}\n`);
    const tail = t.make();
    await tail.tick();
    check(existsSync(file), 'with the plugin it stays, because more will come');
    await tail.stop();
  }
  {
    const t = stageTail({ plugin: false });
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${J({ type: 'hello', plugin: '1.0.0' })}\n${rec({ x: 1 })}\n`);
    const tail = t.make();
    await tail.tick();
    await tail.tick();
    check(existsSync(file), 'a plugin that said hello in this session is running, whatever its jar is called');
    await tail.stop();
  }
  {
    const t = stageTail({ plugin: false });
    const file = path.join(t.folder, `${today}.jsonl`);
    put(file, `${rec({ x: 1 })}\n`);
    const tail = t.make();
    const restore = failOnce('open', (f) => f.endsWith(`${today}.jsonl`));
    await tail.tick();
    restore();
    check(existsSync(file) && await stored(t) === 0, 'without the plugin a file that could not be read stays too');
    await tail.tick();
    check(!existsSync(file) && await stored(t) === 1, 'until it is read');
    await tail.stop();
  }
  {
    const dir = freshDir();
    put(path.join(dir, 'plugins', 'NanoBridge.jar'), 'a jar');
    const store = createStore(dir, { flushMs: 5 });
    store.touch(STEVE, 'Steve');
    await store.flush();
    const file = path.join(dir, '.nano', 'bridge', `${today}.jsonl`);
    put(file, `${rec({ x: 1 })}\n`);
    const players = createPlayers({ send: () => {}, describe: () => ({ version: '26.3', kind: 'paper', proxy: false }), storeOptions: { flushMs: 5 } });
    check(players.bridgeRemove(dir).ok, 'the plugin of a stopped server is removed');
    await waitFor(() => !existsSync(file));
    check(!existsSync(file), 'and its last file goes with it, with no server left to tail it');
    await sleep(30);
    check(readFileSync(path.join(dir, '.nano', 'players', `${STEVE}.jsonl`), 'utf8').includes('"type":"break"'), 'after it was read into the records');
  }
}

// ---------- block and coordinate search ----------
{
  const dir = freshDir();
  const store = createStore(dir, { flushMs: 5 });
  store.add({ type: 'break', name: 'Steve', uuid: STEVE, text: '', world: 'world', x: 10, y: 64, z: -5, n: 3, id: 'minecraft:diamond_ore', at: [[10, 64, -5], [11, 64, -5], [12, 64, -5]] });
  store.add({ type: 'break', name: 'Griefer', uuid: '11111111-2222-3333-4444-555555555555', text: '', world: 'world', x: 100, y: 64, z: 5, n: 1, id: 'minecraft:stone', at: [[12, 64, -5]] });
  store.add({ type: 'chat', name: 'Steve', uuid: STEVE, text: 'minecraft:diamond_ore is nice' });
  store.add({ type: 'join', name: 'Bob', uuid: BOB, text: '', x: 11.5, y: 64, z: -4.5 });
  const search = (opts) => store.search({ limit: 50, ...opts });
  const names = (list) => list.map((e) => e.name).sort().join();
  check(names(await search({ q: '12 64 -5' })) === 'Griefer,Steve', 'who broke this block, across players, from a record\'s list of blocks');
  check(names(await search({ q: '12, 64, -5', types: ['break'] })) === 'Griefer,Steve', 'with commas too');
  check(names(await search({ q: '11 64 -5' })) === 'Bob,Steve', 'a place on an event counts by its block');
  check((await search({ q: '999 0 0' })).length === 0, 'a place nobody touched');
  check(names(await search({ q: 'diamond_ore', types: ['break'] })) === 'Steve', 'by block name');
  check(names(await search({ q: '다이아', ids: ['minecraft:diamond_ore'], types: ['break'] })) === 'Steve', 'by the ids a Korean name stands for');
  check((await store.timeline(STEVE, { q: '11 64 -5' })).events.length === 1, 'a timeline searches the same way');
}

// ---------- a long record stays cheap ----------
{
  const dir = freshDir();
  const store = createStore(dir, { flushMs: 5 });
  const folder = store.folder;
  mkdirSync(folder, { recursive: true });
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const recent = new Date(Date.now() - 86400000).toISOString();
  const lines = [];
  for (let i = 0; i < 200000; i++) lines.push(J({ t: i < 100000 ? old : recent, type: 'break', name: 'Steve', uuid: STEVE, text: '', x: i, y: 1, z: 1, n: 1, id: 'minecraft:stone' }));
  writeFileSync(path.join(folder, `${STEVE}.jsonl`), `${lines.join('\n')}\n{"torn`);
  await store.open();
  const size = statSync(path.join(folder, `${STEVE}.jsonl`)).size;
  check(readFileSync(path.join(folder, `${STEVE}.jsonl`), 'utf8').split('\n').filter(Boolean).length === 100000, `the prune keeps the recent half and drops the torn end, ${size >> 20} MB`);
  const started = Date.now();
  const page = await store.timeline(STEVE, { limit: 100 });
  const took = Date.now() - started;
  check(page.events.length === 100 && page.more && page.events[0].x === 199999, 'a page from the end');
  check(took < 200, `a page of a 100000 line file costs a page: ${took} ms`);
  const next = await store.timeline(STEVE, { limit: 100, before: page.events.at(-1).t });
  check(next.events.length === 0, 'lines of one time stamp page by time, as the store writes none');
}

// ---------- the plugin in a server ----------
{
  const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const SHIPPED = require.resolve('../main/minecraft/players/NanoBridge.jar');
  check(statSync(SHIPPED).size > 5000, 'the jar ships with the app');
  const kinds = { paper: null, purpur: null, vanilla: 'noPlugins', fabric: 'modded', forge: 'modded', neoforge: 'modded', velocity: 'proxy', mystery: 'kind' };
  for (const [kind, code] of Object.entries(kinds)) check(refusal({ kind, version: '26.3' }) === code, `${kind}: ${code}`);
  check(refusal({ kind: 'paper', version: '1.19.4' }) === 'oldVersion' && refusal({ kind: 'paper', version: '1.20' }) === null && refusal({ kind: 'purpur', version: 'x' }) === 'oldVersion', 'the version the plugin\'s api-version allows');
  const dir = freshDir();
  const jar = path.join(dir, 'plugins', 'NanoBridge.jar');
  let desc = { version: '1.21.1', kind: 'paper', proxy: false };
  const players = createPlayers({ send: () => {}, describe: () => desc, sessionOptions: { pingMs: 1, pollMs: 1000000, listMs: 1000000 }, storeOptions: { flushMs: 5 } });
  check(players.bridgeStatus(dir).installed === 'none' && !players.bridgeStatus(dir).code, 'nothing is installed by itself');
  let r = players.bridgeInstall(dir);
  check(r.ok && !r.restart && existsSync(jar) && hash(jar) === hash(SHIPPED), 'install copies the jar');
  check(!readdirSync(path.dirname(jar)).some((n) => n.endsWith('.part')), 'and leaves no temporary file');
  check(players.bridgeStatus(dir).installed === 'current', 'and it reads as installed');
  r = players.bridgeInstall(dir);
  check(r.ok, 'installing twice is fine');
  writeFileSync(jar, 'some other plugin');
  check(players.bridgeStatus(dir).installed === 'other', 'a jar of another content is not called ours');
  r = players.bridgeRemove(dir);
  check(r.ok && !existsSync(jar), 'remove deletes it');
  check(players.bridgeRemove(dir).ok, 'removing twice is fine');

  const session = players.begin(dir);
  const proc = new FakeProcess();
  session.attach(proc);
  session.filter(`${VANILLA}Done (1.0s)! For help, type "help"\n`, 'out');
  check(players.bridgeStatus(dir).running && !players.bridgeStatus(dir).active, 'running, and nothing has said hello');
  r = players.bridgeInstall(dir);
  check(r.ok && r.restart, 'on a running server it asks for a restart');
  check(players.bridgeRemove(dir).restart, 'and so does removing it');
  players.bridgeInstall(dir);
  put(path.join(dir, '.nano', 'bridge', `${new Date().toISOString().slice(0, 10)}.jsonl`), `${J({ v: 1, type: 'hello', plugin: '1.0.0' })}\n`);
  session.end();
  await sleep(50);
  const log = await players.adminLog(dir);
  check(log.filter((e) => e.action.type === 'bridgeInstall').length === 4 && log.filter((e) => e.action.type === 'bridgeRemove').length === 3, 'each change is in the admin log');

  desc = { version: '1.21.1', kind: 'fabric', proxy: false };
  const other = freshDir();
  r = players.bridgeInstall(other);
  check(!r.ok && r.code === 'modded' && !existsSync(path.join(other, 'plugins')), 'a Fabric server gets its reason and no plugin');
  check(players.bridgeStatus(other).code === 'modded', 'and the status says the same');

  const lines = [];
  const logTo = (s) => lines.push(s);
  const fresh = freshDir();
  const on = { 'minecraft.detailedLogNewServers': true };
  check(forNewServer(null, fresh, { kind: 'paper', version: '26.3' }, logTo) === null && forNewServer({}, fresh, { kind: 'paper', version: '26.3' }, logTo) === null, 'the default is off');
  check(forNewServer({ 'minecraft.detailedLogNewServers': 'true' }, fresh, { kind: 'paper', version: '26.3' }, logTo) === null, 'only a real yes turns it on');
  check(!existsSync(path.join(fresh, 'plugins')), 'and with it off nothing is written');
  check(forNewServer(on, fresh, { kind: 'vanilla', version: '26.3' }, logTo) === null && forNewServer(on, fresh, { kind: 'forge', version: '1.20.1' }, logTo) === null, 'other kinds stay as they are');
  check(forNewServer(on, fresh, { kind: 'purpur', version: '26.3' }, logTo)?.ok && existsSync(path.join(fresh, 'plugins', 'NanoBridge.jar')) && lines.length === 1, 'with it on a new Purpur server has the plugin');
}

// ---------- the same default, in the real minecraft:create ----------
{
  const payload = Buffer.from('a stand-in for Paper');
  const paperSha = createHash('sha256').update(payload).digest('hex');
  const http = await import('http');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/paper/versions/1.21.1/builds') res.end(J([{ id: 1, channel: 'STABLE', downloads: { 'server:default': { url: `${base}/paper.jar`, size: payload.length, checksums: { sha256: paperSha } } } }]));
    else if (req.url === '/paper.jar') res.end(payload);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const before = process.env.PYIDE_MC_SOURCES;
  process.env.PYIDE_MC_SOURCES = J({ paper: `http://127.0.0.1:${server.address().port}/paper` });
  const load = Module._load;
  const userData = freshDir();
  const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => userData, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : class {}) });
  Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
  const name = require.resolve('../main/features/minecraft.js');
  const held = require.cache[name];
  delete require.cache[name];
  const feature = require('../main/features/minecraft.js');
  Module._load = load;
  require.cache[name] = held;
  const handlers = new Map();
  feature.register({ ipcMain: { handle: (h, fn) => handlers.set(h, fn), on() {} }, send() {}, startProcess() {}, procs: new Map(), diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
  const root = freshDir();
  const create = (n) => handlers.get('minecraft:create')({}, { root, name: n, kind: 'paper', mc: '1.21.1', memory: '256M', port: 25599, eula: true }, 'job');
  await create('Plain');
  check(existsSync(path.join(root, 'servers', 'Plain', 'pyide-server.json')) && !existsSync(path.join(root, 'servers', 'Plain', 'plugins', 'NanoBridge.jar')), 'minecraft:create adds no plugin while the default is off');
  writeFileSync(path.join(userData, 'settings.json'), J({ 'minecraft.detailedLogNewServers': true }));
  await create('Logged');
  check(existsSync(path.join(root, 'servers', 'Logged', 'plugins', 'NanoBridge.jar')), 'and adds it once the owner turned the default on');
  const all = await handlers.get('players:bridgeServers')({}, root);
  check(all.length === 2 && all.find((s) => s.name === 'Logged').installed === 'current' && all.find((s) => s.name === 'Plain').installed === 'none', `players:bridgeServers lists the project: ${J(all.map((s) => [s.name, s.installed]))}`);
  const done = await handlers.get('players:bridgeInstall')({}, root, path.join(root, 'servers', 'Plain'));
  check(done.ok && existsSync(path.join(root, 'servers', 'Plain', 'plugins', 'NanoBridge.jar')), 'players:bridgeInstall from another server\'s tab');
  server.close();
  if (before === undefined) delete process.env.PYIDE_MC_SOURCES;
  else process.env.PYIDE_MC_SOURCES = before;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED: ${f.label}`);
process.exit(failed.length ? 1 : 0);
