// The Players tab end to end: renderer/features/minecraft/players.js, the players:* channels and the session on a real
// process, started through the real minecraft:start. A Node script plays the server: it prints log lines in each kind's
// format (vanilla, Paper, Fabric, Forge), answers list, data get and the action commands, writes ops.json, whitelist.json
// and banned-players.json as a server does, and records every command that reached it in commands.log. A second run shows
// the tab in Korean and later ones the craft window's own flows. No real server, game, launcher or sign-in, and no network: the
// catalog's Mojang address is a closed port, and its items come from a seeded cache.
// Checks: the card's Players button, offline data from fixture files (a playerdata .dat written by hand, a
// damaged one, a missing one), join and leave, online first, the timeline with its filters, search and paging, forged
// chat, the console not showing the app's queries, inventories in both item formats, tooltips, a slot replaced and
// emptied, give and clear with the exact commands that reached the server, confirmations, each action's result, the
// admin log, search across players, a server that stops answering and one that dies, a proxy, a long list, Korean text,
// 900 px and narrower, and no CSP violation.
// Every press and hover goes through Input.dispatchMouseEvent at a spot elementFromPoint says is the control: a synthetic
// click reaches a button that is covered, has moved or was never on screen, which is how this tab once lost every click
// under an open list while its checks passed. Wide, 1024 and 900 px screenshots are taken in Korean.
// The log lines and SNBT here are written from the formats in docs/craft-players-design.md and the commands' wiki pages.
// They are not captures from a real server. Ports 9932-9934. Screenshots go to verify/out/minecraft-players/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { launch, processSnapshot } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-mcplayers-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const serverDir = (name) => path.join(project, 'servers', name);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const STEVE = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const ALEX = '853c80ef-3c37-49fd-aa49-938b674adae6';
const GRIEFER = '11111111-2222-3333-4444-555555555555';
const UUIDS = { Steve: STEVE, Alex: ALEX, Griefer: GRIEFER };
// usercache.json as a server writes it: an entry without a date it can read is no entry to it.
const cached = (...names) => S(names.map((name) => ({ name, uuid: UUIDS[name], expiresOn: '2099-01-01 00:00:00 +0000' })));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------- the stand-in server ----------
function standIn() {
  /* eslint-disable */
  const fs = require('fs');
  const readline = require('readline');
  const cfg = JSON.parse(fs.readFileSync('standin.json', 'utf8'));
  const PREFIX = { vanilla: '[12:00:00] [Server thread/INFO]: ', paper: '[12:00:00 INFO]: ', forge: '[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: ',
    fabric: '[12:00:00] [Server thread/INFO] (Minecraft) ' }[cfg.kind];
  const AUTH = { vanilla: '[12:00:00] [User Authenticator #1/INFO]: ', paper: PREFIX, forge: '[12:00:00] [User Authenticator #1/INFO] [minecraft/ServerLoginPacketListenerImpl]: ',
    fabric: '[12:00:00] [User Authenticator #1/INFO] (Minecraft) ' }[cfg.kind];
  const online = new Map();
  let hung = false;
  let delay = 0;
  const out = (line) => process.stdout.write(`${line}\n`);
  // `log` is the server's own logger, which chat and the start and stop lines come through. `say` is what the console is
  // told: answers and broadcasts, which 26.3 logs behind `System chat: ` and 1.20.1 logs bare.
  const log = (msg) => out(`${PREFIX}${msg}`);
  const say = (msg) => log(`${cfg.systemChat ? 'System chat: ' : ''}${msg}`);
  const pretty = (id) => id.replace(/^minecraft:/, '').replace(/[[{].*$/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const edit = (file, change) => {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    fs.writeFileSync(file, JSON.stringify(change(list)));
  };
  const uuidOf = (name) => cfg.uuids[name] ?? '99999999-9999-3999-8999-999999999999';
  const leave = (name, why) => {
    if (!online.delete(name)) return;
    log(`${name} lost connection: ${why}`);
    say(`${name} left the game`);
  };
  const needs = (name, then) => (online.has(name) ? then(online.get(name)) : say('No player was found'));
  const game = cfg.game ? require(cfg.game.path).createGame({ version: cfg.mc, name: 'Steve', stacks: cfg.game.stacks }) : null;
  let losing = null; // a slot that empties right after the next copy, as a stack can go between two lines
  function command(line) {
    let m;
    if (line === 'stop') { log('Stopping the server'); process.stdout.write('', () => process.exit(0)); return; }
    if (game && line === 'data get entity Steve' && online.has('Steve')) { say(`Steve has the following entity data: ${game.data()}`); return; }
    const said = game?.run(line);
    if (said) {
      said.forEach(say);
      if (losing !== null && line.includes(' from entity ')) { game.held.delete(losing); losing = null; }
      return;
    }
    if (line === 'list') { const names = [...online.keys()]; say(`There are ${names.length} of a max of 20 players online: ${names.join(', ')}`); return; }
    // commands.list.nameAndId, "%s (%s)", joined by ", ".
    if (line === 'list uuids') { const names = [...online.keys()]; say(`There are ${names.length} of a max of 20 players online: ${names.map((n) => `${n} (${uuidOf(n)})`).join(', ')}`); return; }
    if ((m = /^data get entity (\S+)(?: (\S+))?$/.exec(line))) {
      const p = online.get(m[1]);
      if (!p) { say('No entity was found'); return; }
      const value = !m[2] ? cfg.data[m[1]] ?? '{Health: 20.0f}' : m[2] === 'Pos' ? `[${p.x}d, ${p.y}d, ${p.z}d]` : `"${p.dimension}"`;
      setTimeout(() => say(`${m[1]} has the following entity data: ${value}`), m[2] ? 0 : delay);
      return;
    }
    if ((m = /^give (\S+) (\S+) (\d+)$/.exec(line))) {
      if (/nope/.test(m[2])) { say(`Unknown item '${m[2]}'`); return; }
      needs(m[1], () => say(`Gave ${m[3]} [${pretty(m[2])}] to ${m[1]}`));
      return;
    }
    if ((m = /^clear (\S+)/.exec(line))) { needs(m[1], () => say(`Removed 3 item(s) from player ${m[1]}`)); return; }
    if ((m = /^item replace entity (\S+) \S+ with (\S+) \d+$/.exec(line))) { needs(m[1], () => say(`Replaced a slot on ${m[1]} with [${pretty(m[2])}]`)); return; }
    if ((m = /^tp (\S+) (.+)$/.exec(line))) { needs(m[1], () => say(`Teleported ${m[1]} to ${m[2]}`)); return; }
    if ((m = /^gamemode (\S+) (\S+)$/.exec(line))) { needs(m[2], () => say(`Set ${m[2]}'s game mode to ${pretty(m[1])} Mode`)); return; }
    if ((m = /^effect give (\S+) (\S+)/.exec(line))) { needs(m[1], () => say(`Applied effect ${pretty(m[2])} to ${m[1]}`)); return; }
    if ((m = /^effect clear (\S+)/.exec(line))) { needs(m[1], () => say(`Removed every effect from ${m[1]}`)); return; }
    if ((m = /^msg (\S+) (.*)$/.exec(line))) { needs(m[1], () => say(`You whisper to ${m[1]}: ${m[2]}`)); return; }
    if ((m = /^kick (\S+)(?: (.*))?$/.exec(line))) { needs(m[1], () => { say(`Kicked ${m[1]}: ${m[2] || 'Kicked by an operator'}`); leave(m[1], m[2] || 'Kicked by an operator'); }); return; }
    if ((m = /^ban (\S+)(?: (.*))?$/.exec(line))) {
      const name = m[1];
      edit('banned-players.json', (l) => [...l, { uuid: uuidOf(name), name, reason: m[2] || 'Banned by an operator.', expires: 'forever' }]);
      say(`Banned ${name}: ${m[2] || 'Banned by an operator.'}`);
      leave(name, 'You are banned from this server.');
      return;
    }
    if ((m = /^pardon (\S+)$/.exec(line))) { edit('banned-players.json', (l) => l.filter((e) => e.name !== m[1])); say(`Unbanned ${m[1]}`); return; }
    if ((m = /^op (\S+)$/.exec(line))) {
      if (fs.existsSync('ops.json') && JSON.parse(fs.readFileSync('ops.json', 'utf8')).some((e) => e.name === m[1])) { say('Nothing changed. The player is already an operator'); return; }
      edit('ops.json', (l) => [...l, { uuid: uuidOf(m[1]), name: m[1], level: 4, bypassesPlayerLimit: false }]);
      say(`Made ${m[1]} a server operator`);
      return;
    }
    if ((m = /^deop (\S+)$/.exec(line))) { edit('ops.json', (l) => l.filter((e) => e.name !== m[1])); say(`Made ${m[1]} no longer a server operator`); return; }
    if ((m = /^whitelist add (\S+)$/.exec(line))) { edit('whitelist.json', (l) => [...l, { uuid: uuidOf(m[1]), name: m[1] }]); say(`Added ${m[1]} to the whitelist`); return; }
    if ((m = /^whitelist remove (\S+)$/.exec(line))) { edit('whitelist.json', (l) => l.filter((e) => e.name !== m[1])); say(`Removed ${m[1]} from the whitelist`); return; }
    say('Unknown or incomplete command, see below for error');
  }
  // What a test tells the stand-in, on the same stdin. Never recorded as a command.
  function control(line) {
    const [word, ...rest] = line.split(' ');
    if (word === 'emit') log(rest.join(' '));
    if (word === 'click') game.swap(Number(rest[0]), Number(rest[1]));
    if (word === 'lose') losing = Number(rest[0]);
    if (word === 'stacks') fs.writeFileSync('stacks.json', JSON.stringify(Object.fromEntries(game.held)));
    if (word === 'told') say(rest.join(' '));
    if (word === 'ghost') online.set(rest[0], { x: 1, y: 64, z: 1, dimension: cfg.dimension });
    if (word === 'join') {
      const name = rest[0];
      online.set(name, { x: 10.5, y: 64, z: -3.25, dimension: cfg.dimension });
      out(`${AUTH}UUID of player ${name} is ${uuidOf(name)}`);
      // The server caches who has the name for a month and saves the file at once (yyyy-MM-dd HH:mm:ss Z).
      const month = new Date(Date.now() + 30 * 86400000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
      edit('usercache.json', (l) => [{ name, uuid: uuidOf(name), expiresOn: month }, ...l.filter((e) => e.uuid !== uuidOf(name) && e.name?.toLowerCase() !== name.toLowerCase())]);
      log(`${name}[/203.0.113.7:51234] logged in with entity id 123 at (10.5, 64.0, -3.25)`);
      say(`${name} joined the game`);
    }
    if (word === 'leave') leave(rest[0], 'Disconnected');
    if (word === 'move') Object.assign(online.get(rest[0]), { x: Number(rest[1]), y: Number(rest[2]), z: Number(rest[3]) });
    if (word === 'burst') for (let i = 1; i <= Number(rest[1]); i++) log(`<${rest[0]}> line ${i}`);
    if (word === 'hang') hung = true;
    if (word === 'delay') delay = Number(rest[0]);
    if (word === 'die') process.exit(1);
    if (word === 'up') log('Done (0.4s)! For help, type "help"');
  }
  log(`Starting minecraft server version ${cfg.mc}`);
  if (!cfg.slowStart) log('Done (0.4s)! For help, type "help"');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.startsWith('#')) { control(line.slice(1)); return; }
    fs.appendFileSync('commands.log', `${line}\n`);
    if (!hung) command(line);
  });
  lines.on('close', () => process.exit(0));
}
const script = path.join(work, 'stand-in.cjs');
write(script, `(${standIn.toString()})();\n`);

// ---------- binary NBT for the saved player ----------
const be = (method, size, value) => { const b = Buffer.alloc(size); b[method](value); return b; };
const text = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([be('writeUInt16BE', 2, b.length), b]); };
const named = (type, name, payload) => Buffer.concat([Buffer.from([type]), text(name), payload]);
const T = {
  byte: (n, v) => named(1, n, be('writeInt8', 1, v)), short: (n, v) => named(2, n, be('writeInt16BE', 2, v)), int: (n, v) => named(3, n, be('writeInt32BE', 4, v)),
  float: (n, v) => named(5, n, be('writeFloatBE', 4, v)), string: (n, v) => named(8, n, text(v)),
  list: (n, type, items) => named(9, n, Buffer.concat([Buffer.from([type]), be('writeInt32BE', 4, items.length), ...items])),
  compound: (n, ...kids) => named(10, n, Buffer.concat([...kids, Buffer.from([0])])),
};
const body = (...kids) => Buffer.concat([...kids, Buffer.from([0])]);
const newItem = (slot, id, count, ...comps) => body(T.byte('Slot', slot), T.string('id', id), T.int('count', count), ...(comps.length ? [T.compound('components', ...comps)] : []));
const savedSteve = zlib.gzipSync(T.compound('',
  T.list('Pos', 6, [100.5, 72, -40.25].map((v) => be('writeDoubleBE', 8, v))), T.float('Health', 18.5), T.int('foodLevel', 17), T.int('XpLevel', 30), T.int('playerGameType', 1), T.int('SelectedItemSlot', 4),
  T.string('Dimension', 'minecraft:the_nether'),
  T.list('Inventory', 10, [
    newItem(0, 'minecraft:diamond_sword', 1, T.int('minecraft:damage', 7), T.compound('minecraft:enchantments', T.compound('levels', T.int('minecraft:sharpness', 5)))),
    newItem(9, 'minecraft:stone', 64), newItem(103, 'minecraft:iron_helmet', 1), newItem(-106, 'minecraft:shield', 1),
  ]),
  T.list('EnderItems', 10, [newItem(2, 'minecraft:ender_pearl', 16)])));

// ---------- the project ----------
const desc = (kind, mc) => S({ kind, mc, java: 21, memory: '256M', launch: { jar: 'server.jar' } });
const COMPONENT_DATA = (name) => `{Health: 12.5f, foodLevel: 9, XpLevel: 4, playerGameType: 0, SelectedItemSlot: 1, Pos: [10.5d, 64.0d, -3.25d], Dimension: "minecraft:overworld", Inventory: [
  {Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}, "minecraft:damage": 1200}},
  {Slot: 1b, id: "minecraft:dirt", count: 32},
  {Slot: 9b, id: "minecraft:stick", count: 1, components: {"minecraft:custom_name": '{"text":"<img src=x onerror=window.__pwned=1>"}'}},
  {Slot: 102b, id: "minecraft:diamond_chestplate", count: 1},
  {Slot: -106b, id: "minecraft:shield", count: 1}], EnderItems: [{Slot: 0b, id: "minecraft:ender_pearl", count: 16}], name: "${name}"}`.replace(/\n\s*/g, ' ');
const TAG_DATA = () => `{Health: 20.0f, foodLevel: 20, XpLevel: 1, playerGameType: 1, SelectedItemSlot: 0, Pos: [1.0d, 70.0d, 2.0d], Dimension: "minecraft:the_end", Inventory: [
  {Slot: 0b, id: "minecraft:netherite_sword", Count: 1b, tag: {Damage: 3, Enchantments: [{id: "minecraft:looting", lvl: 3s}], display: {Name: '{"text":"Oathbreaker"}'}}},
  {Slot: 1b, id: "somemod:laser_drill", Count: 1b, tag: {Damage: 12}},
  {Slot: 100b, id: "minecraft:leather_boots", Count: 1b}], EnderItems: []}`.replace(/\n\s*/g, ' ');
const EQUIPMENT_DATA = () => `{Health: 7.0f, foodLevel: 3, XpLevel: 2, playerGameType: 2, SelectedItemSlot: 0, Pos: [0.0d, 0.0d, 0.0d], Dimension: "minecraft:the_nether", Inventory: [
  {Slot: 3b, id: "minecraft:bow", count: 1, components: {"minecraft:enchantments": {"minecraft:power": 4}, "minecraft:custom_name": {text: "Longshot"}}}],
  equipment: {head: {id: "minecraft:turtle_helmet", count: 1}, offhand: {id: "minecraft:torch", count: 12}}, EnderItems: []}`.replace(/\n\s*/g, ' ');

const SERVERS = {
  vanilla: { mc: '1.21.1', dimension: 'minecraft:overworld', data: { Steve: COMPONENT_DATA('Steve'), Alex: COMPONENT_DATA('Alex') } },
  paper: { mc: '1.20.4', dimension: 'minecraft:the_end', data: { Steve: TAG_DATA() }, slowStart: true },
  fabric: { mc: '1.21.5', dimension: 'minecraft:the_nether', data: { Steve: EQUIPMENT_DATA() } },
  forge: { mc: '1.20.1', dimension: 'minecraft:the_end', data: { Steve: TAG_DATA() } },
};
for (const [kind, s] of Object.entries(SERVERS)) {
  write(path.join(serverDir(kind), 'pyide-server.json'), desc(kind, s.mc));
  write(path.join(serverDir(kind), 'standin.json'), S({ kind, mc: s.mc, data: s.data, uuids: UUIDS, dimension: s.dimension, slowStart: !!s.slowStart }));
}
write(path.join(serverDir('modern'), 'pyide-server.json'), desc('vanilla', '26.3'));
write(path.join(serverDir('modern'), 'standin.json'), S({ kind: 'vanilla', mc: '26.3', data: { Steve: EQUIPMENT_DATA() }, uuids: UUIDS, dimension: 'minecraft:overworld', systemChat: true }));
write(path.join(serverDir('modern'), 'usercache.json'), cached('Steve', 'Alex'));
write(path.join(serverDir('proxy'), 'pyide-server.json'), desc('velocity', '3.4.0'));
write(path.join(serverDir('proxy'), 'standin.json'), S({ kind: 'vanilla', mc: '3.4.0', data: {}, uuids: UUIDS, dimension: 'minecraft:overworld' }));
const GAME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'minecraft-players-game.cjs');
const DRAG_STACKS = { 0: { id: 'minecraft:diamond_sword', count: 1, extra: 'components: {"minecraft:damage": 12}' }, 1: { id: 'minecraft:dirt', count: 32 }, 2: { id: 'minecraft:diamond', count: 3 }, 9: { id: 'minecraft:stone', count: 64 }, 10: { id: 'minecraft:dirt', count: 7 }, 200: { id: 'minecraft:diamond', count: 5 } };
write(path.join(serverDir('drag'), 'pyide-server.json'), desc('paper', '1.21.1'));
write(path.join(serverDir('drag'), 'standin.json'), S({ kind: 'paper', mc: '1.21.1', data: {}, uuids: UUIDS, dimension: 'minecraft:overworld', game: { path: GAME, stacks: DRAG_STACKS } }));
write(path.join(serverDir('drag'), 'usercache.json'), cached('Steve', 'Alex'));
write(path.join(serverDir('drag'), 'world', 'playerdata', `${STEVE}.dat`), savedSteve);
write(path.join(serverDir('papertwo'), 'pyide-server.json'), desc('purpur', '1.21.1'));
write(path.join(serverDir('papertwo'), 'standin.json'), S({ kind: 'paper', mc: '1.21.1', data: {}, uuids: UUIDS, dimension: 'minecraft:overworld' }));
write(path.join(serverDir('paperold'), 'pyide-server.json'), desc('paper', '1.19.4'));
write(path.join(serverDir('big'), 'pyide-server.json'), desc('vanilla', '1.21.1'));
const crowd = Array.from({ length: 3000 }, (_, i) => ({ name: `Player${i}`, uuid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, expiresOn: '2030-01-01 00:00:00 +0000' }));
write(path.join(serverDir('big'), 'usercache.json'), S(crowd));
const vanilla = serverDir('vanilla');
write(path.join(vanilla, 'usercache.json'), cached('Steve', 'Alex', 'Griefer'));
write(path.join(vanilla, 'whitelist.json'), S([{ uuid: STEVE, name: 'Steve' }]));
write(path.join(vanilla, 'banned-players.json'), S([{ uuid: GRIEFER, name: 'Griefer', reason: 'x', expires: 'forever' }]));
write(path.join(vanilla, 'world', 'playerdata', `${STEVE}.dat`), savedSteve);
write(path.join(vanilla, 'world', 'playerdata', `${GRIEFER}.dat`), Buffer.from('this is no player file'));
write(path.join(vanilla, 'world', 'stats', `${STEVE}.json`), S({ stats: { 'minecraft:custom': { 'minecraft:play_time': 72000, 'minecraft:deaths': 3, 'minecraft:mob_kills': 41, 'minecraft:jump': 900 } } }));
write(path.join(vanilla, 'world', 'advancements', `${STEVE}.json`), S({ 'minecraft:story/root': { done: true }, 'minecraft:story/mine_stone': { done: true }, 'minecraft:recipes/misc/x': { done: true } }));

// The catalog of 1.21.1 comes from this cache, so nothing is fetched. Every other version finds a closed port.
const installRoot = path.join(work, 'install-root');
const catalog = [['diamond_sword', 'Diamond Sword', '다이아몬드 검'], ['diamond', 'Diamond', '다이아몬드'], ['dirt', 'Dirt', '흙'], ['stone', 'Stone', '돌'], ['stick', 'Stick', '막대기']];
const nameList = (rows) => rows.map(([id, name, ko]) => ({ id: `minecraft:${id}`, name, ko }));
write(path.join(installRoot, 'minecraft-items', '1.21.1', 'items.json'), S({ format: 2, version: '1.21.1', items: catalog.map(([id, name, ko], i) => ({ id: `minecraft:${id}`, name, ko, icon: i < 3 ? PNG : null, mod: null })),
  enchantments: nameList([['sharpness', 'Sharpness', '날카로움'], ['smite', 'Smite', '강타'], ['mending', 'Mending', '수선']]), effects: nameList([['speed', 'Speed', '신속'], ['slowness', 'Slowness', '구속'], ['haste', 'Haste', '성급함']]) }));
// PYIDE_CRAFT_HOME: without it a craft window opens the user's own ~/Nano Studio Craft, whatever projectDir says.
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: installRoot, PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_SOURCES: S({ mojang: 'http://127.0.0.1:1/manifest.json', mojangAssets: 'http://127.0.0.1:1/assets' }) };

// ---------- helpers for a window ----------
const tabOf = `document.querySelector('.custom-tab.mcpl:not(.hidden)')`;
const lastDialog = `[...document.querySelectorAll('.dialog')].at(-1)`;
const dialogButton = (label) => `[...(${lastDialog}?.querySelectorAll('.dialog-buttons button') ?? [])].find((b) => b.textContent === ${S(label)})`;
const pickRows = `[...document.querySelectorAll('.mcpl-picks .mcpl-pick')]`;
const pickRow = (id) => `document.querySelector('.mcpl-picks .mcpl-pick[data-id="${id}"]')`;
function helpers({ js, until, cdp, sleep }) {
  const q = (sel) => `${tabOf}?.querySelector(${S(sel)})`;
  const qa = (sel) => `[...(${tabOf}?.querySelectorAll(${S(sel)}) ?? [])]`;
  // Where the pointer goes for the node `expr`, which must be what a person's pointer would touch there.
  const spotOf = async (expr, stay = false) => {
    const spot = await js(`(() => {
      const n = ${expr};
      if (!n) return null;
      if (!${stay}) n.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = n.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, top: r.top, hit: !!hit && (n === hit || n.contains(hit)), under: hit ? (hit.className || hit.tagName) : 'nothing', off: !!n.disabled };
    })()`);
    if (!spot) throw new Error(`nothing to press: ${expr}`);
    if (!spot.hit) throw new Error(`${spot.under} covers ${expr}`);
    if (spot.off) throw new Error(`disabled: ${expr}`);
    return spot;
  };
  const down = (spot) => cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
  const up = (spot) => cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 });
  const moveTo = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  // A press and a release, a moment apart as a hand's are: `during` runs in between, while a list closes on the blur.
  const mouse = async (expr, during, stay) => {
    const spot = await spotOf(expr, stay);
    await moveTo(spot.x, spot.y);
    await down(spot);
    await sleep(40);
    await during?.(spot);
    await up(spot);
    await sleep(40);
    return spot;
  };
  // A scroll takes a tooltip down, and spotOf may have just caused one: its event comes a frame later.
  const hover = async (expr) => { const spot = await spotOf(expr); await sleep(120); await moveTo(spot.x, spot.y); };
  const away = () => moveTo(2, 2);
  const press = (sel) => mouse(q(sel));
  const textOf = (sel) => js(`${q(sel)}?.textContent ?? ''`);
  const setValue = (sel, value) => js(`(() => { const n = ${q(sel)}; n.value = ${S(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const row = (name) => `${tabOf}?.querySelector('.mcpl-row[data-name="${name}"]:not(.hidden)')`;
  const folded = () => js(`(() => { const f = ${q('.mcpl-fold')}; return !!f?.offsetParent && ${q('.mcpl-side')}.classList.contains('folded'); })()`);
  const choose = async (name) => {
    if (await folded()) await press('.mcpl-fold');
    await until(`!!${row(name)}`, `row of ${name}`, 10000);
    await mouse(row(name));
    await until(`${q('.mcpl-name')}?.textContent === ${S(name)}`, `${name} selected`, 10000);
  };
  const section = (id) => press(`.mcpl-tab[data-section="${id}"]`);
  const answer = async (label) => {
    await until(`!!(${dialogButton(label)})`, `dialog button ${label}`, 10000);
    await mouse(dialogButton(label));
  };
  // The result bar of the action `run` starts, once it has one: `Sending` comes first.
  const resultOf = async (run) => {
    await js(`(${q('.mcpl-result')}.replaceChildren(), true)`);
    await run();
    await until(`!!${q('.mcpl-result')}?.textContent && !${q('.mcpl-result')}.classList.contains('sending')`, 'an action result', 10000);
    return textOf('.mcpl-result');
  };
  // A tab covers the whole craft window, the server list included.
  const toCards = () => js(`(ide.tabs.slice().forEach((tab) => ide.closeTabObject(tab, true)), ide.minecraft.screen.show('servers'), true)`);
  const openCard = async (name, host = '#minecraftScreen') => {
    await toCards();
    await until(`!!document.querySelector('${host} .mc-server[data-name="${name}"] .mc-players')?.offsetParent`, `Players on the card of ${name}`, 15000);
    await mouse(`document.querySelector('${host} .mc-server[data-name="${name}"] .mc-players')`);
    await until(`${tabOf} && ide.activeTab()?.path.endsWith(${S(`servers\\${name}`.toLowerCase())})`, `the players tab of ${name}`, 10000);
  };
  // A press, moves with the button held, and a release, all through the input pipeline. `during` runs over the target.
  const dragTo = async (fromExpr, toExpr, { during, keepHolding } = {}) => {
    const from = await spotOf(fromExpr);
    const to = await spotOf(toExpr, true);
    await moveTo(from.x, from.y);
    await down(from);
    await sleep(30);
    const held = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await held(from.x + 6, from.y + 6);
    await sleep(30);
    await held((from.x + to.x) / 2, (from.y + to.y) / 2);
    await sleep(30);
    await held(to.x, to.y);
    await sleep(40);
    const seen = await during?.(to);
    if (keepHolding) return seen;
    await up(to);
    await sleep(60);
    return seen;
  };
  return { q, qa, press, textOf, setValue, row, folded, choose, section, answer, resultOf, openCard, toCards, mouse, hover, away, spotOf, dragTo, up };
}
// Real press and release on the button below an open list, and in the dialog, where the list used to open by itself.
// The list must move nothing, whatever it does on the blur the press causes.
async function lostClicks(ctx, h, tag, who, server) {
  const { js, until, shot, type } = ctx;
  const { q, section, setValue, mouse, press, answer } = h;
  const top = (sel) => js(`${q(sel)}.getBoundingClientRect().top`);
  const countClicks = (sel) => js(`(() => { window.__clicks = 0; ${q(sel)}.addEventListener('click', () => { window.__clicks += 1; }); return true; })()`);
  const sent = () => sentBy(server).length;
  await section('actions');
  await countClicks('.mcpl-give-go');
  while (await js(`!!${q('.mcpl-give .mcpl-enchant-remove')}`)) await press('.mcpl-give .mcpl-enchant-remove');
  await setValue('.mcpl-give-count', '');
  await setValue('.mcpl-give-item', '');
  await press('.mcpl-give-item');
  const closed = await top('.mcpl-give-go');
  await type('minecraft:stick');
  await until(`${pickRows}.length === 1`, 'a one row list', 8000);
  check(await top('.mcpl-give-go') === closed && await js(`document.activeElement === ${q('.mcpl-give-item')}`), `${tag}: the open list moves nothing and leaves the keyboard in the box`);
  let during = null;
  const said = await h.resultOf(() => mouse(q('.mcpl-give-go'), async (spot) => { during = { moved: await top('.mcpl-give-go') - spot.top, list: await js(`!!document.querySelector('.mcpl-picks')`) }; }));
  check(during.moved === 0 && !during.list, `${tag}: the button stays put while the list closes under the press (${S(during)})`);
  check(await js(`window.__clicks`) === 1 && await reached(server, `give ${who} minecraft:stick 1`), `${tag}: a press on Give with a one row list open is one click, and the item is given (${said})`);
  await shot(`${tag}-give-after-list.png`);
  await press('.mcpl-result-close');
  await setValue('.mcpl-give-item', '');
  await js(`(${q('.mcpl-give-go')}.scrollIntoView({ block: 'end' }), true)`);
  await mouse(q('.mcpl-give-item'), null, true);
  const closedAgain = await top('.mcpl-give-go');
  await until(`${pickRows}.length === 5`, 'the whole list', 8000);
  const tall = await js(`(() => { const b = ${q('.mcpl-give-go')}.getBoundingClientRect(); const x = b.x + b.width / 2; const y = b.y + b.height / 2; return { x, y, top: b.top, under: !!document.elementFromPoint(x, y)?.closest('.mcpl-picks') }; })()`);
  check(tall.top === closedAgain, `${tag}: a tall list moves nothing either (${S(tall)})`);
  await shot(`${tag}-give-tall-list.png`);
  const before = sent();
  for (const type of ['mousePressed', 'mouseReleased']) await ctx.cdp('Input.dispatchMouseEvent', { type, x: tall.x, y: tall.y, button: 'left', buttons: 1, clickCount: 1 });
  await ctx.sleep(300);
  if (tall.under) check(sent() === before && await js(`${q('.mcpl-give .mcpl-picker')}.classList.contains('chosen') && !document.querySelector('.mcpl-picks')`), `${tag}: a press where the list covers Give picks a row and sends nothing`);
  else check(await js(`window.__clicks`) === 2, `${tag}: a press on Give with the tall list open is one click (${await js(`window.__clicks`)})`);
  await section('inventory');
  await until(`${q('.mcpl-tile[data-slot="0"]')}?.classList.contains('editable')`, 'an editable slot', 8000);
  const openSlot = async () => {
    await press('.mcpl-tile[data-slot="0"]');
    await until(`!!document.querySelector('.dialog .mcpl-slot-item')`, 'the slot dialog', 5000);
  };
  const dialogGone = (ms = 3000) => until(`!document.querySelector('.dialog')`, 'the dialog closed', ms);
  await openSlot();
  await ctx.sleep(500);
  check(await js(`!document.querySelector('.mcpl-picks') && document.activeElement === document.querySelector('.dialog .mcpl-slot-item')`), `${tag}: the slot dialog takes the keyboard without opening the list`);
  await shot(`${tag}-slot-dialog.png`);
  await mouse(dialogButton(ko(ctx, 'Cancel')));
  await dialogGone();
  check(true, `${tag}: the first press on Cancel closes the slot dialog`);
  await openSlot();
  await mouse(`document.querySelector('.dialog .mcpl-slot-item')`);
  await until(`${pickRows}.length === 5`, 'the list in the dialog', 8000);
  const clip = await js(`(() => { const p = document.querySelector('.mcpl-picks').getBoundingClientRect(); const f = document.querySelector('.dialog .dialog-buttons').getBoundingClientRect(); const row = ${pickRows}[0].getBoundingClientRect(); return { bottom: p.bottom, buttons: f.top, height: p.height, rowOnTop: !!document.elementFromPoint(row.x + 20, row.y + row.height / 2)?.closest('.mcpl-picks') }; })()`);
  check(clip.bottom <= clip.buttons && clip.rowOnTop && clip.height > 60, `${tag}: the list lies over the dialog, unclipped, and stops above its buttons (${S(clip)})`);
  await shot(`${tag}-slot-dialog-list.png`);
  await mouse(dialogButton(ko(ctx, 'Cancel')));
  await dialogGone();
  check(true, `${tag}: Cancel below the open list works on the first press`);
  await openSlot();
  await mouse(`document.querySelector('.dialog .mcpl-slot-item')`);
  await type('stone');
  await until(`${pickRows}.length === 1`, 'one row in the dialog', 8000);
  await ctx.press('Escape');
  check(await js(`!document.querySelector('.mcpl-picks') && !!document.querySelector('.dialog .mcpl-slot-item') && document.querySelector('.dialog .mcpl-slot-item').value === 'stone'`), `${tag}: Escape closes only the list, and the typing stays`);
  await ctx.press('ArrowDown');
  await until(`${pickRows}.length === 1`, 'the list back on Arrow Down', 5000);
  await mouse(dialogButton(ko(ctx, 'Replace')));
  await until(`[...document.querySelectorAll('.dialog')].length === 2`, 'the question after Replace', 5000);
  check(true, `${tag}: Replace below the open list works on the first press`);
  await answer(ko(ctx, 'Cancel'));
  await ctx.press('Escape');
  await dialogGone();
  await section('overview');
}
const KO = { Cancel: '취소', Replace: '바꾸기' };
const ko = (ctx, label) => (ctx.korean ? KO[label] : label);
const dirOf = (root, name) => `${root}\\servers\\${name}`;
async function start(ctx, name) {
  const root = await ctx.js('ide.root');
  const spec = { cmd: process.execPath, args: [script], cwd: dirOf(root, name) };
  // The process's output as a console gets it: main has already taken the session's own lines out.
  return ctx.js(`(async () => {
    const id = await ide.api.invoke('minecraft:start', ide.root, ${S(spec)});
    (window.__out ??= {})[id] = [];
    ide.proc.attach(id, { data: (text) => window.__out[id].push(text), exit: () => { (window.__exited ??= []).push(id); } });
    return id;
  })()`);
}
const tell = (ctx, id, line) => ctx.js(`(ide.proc.input(${id}, ${S(`#${line}\n`)}), true)`);
const consoleOf = (ctx, id) => ctx.js(`window.__out[${id}].join('')`);
const logOf = (name) => { const f = path.join(serverDir(name), 'commands.log'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };
const sentBy = (name) => logOf(name).filter((l) => !/^(data get |list uuids$)/.test(l));
const reached = async (name, line, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (logOf(name).includes(line)) return true; await pause(50); }
  return false;
};
const say = (ctx, id, msg) => tell(ctx, id, `emit ${msg}`);

// ---------- English ----------
mkdirSync(project, { recursive: true });
const t = await launch({ name: 'minecraft-players', port: 9932, mode: 'craft', projectDir: project, env });
const { js, until, check, shot, cdp, type } = t;
const { q, qa, press, textOf, setValue, row, choose, section, answer, resultOf, openCard, toCards, mouse, hover, away, folded } = helpers(t);
// A Start press must never launch anything here: it records the config the card's flow hands over and takes a moment.
const stubRun = (ctx) => ctx.js(`(() => { window.__started = []; ide.run.runConfig = async (cfg) => { window.__started.push(cfg); await new Promise((r) => { setTimeout(r, 400); }); }; return true; })()`);

try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
  await js(`ide.minecraft.refresh()`);
  await toCards();
  if (!samePath(await js('ide.root'), project)) throw new Error('the window is not on the test project');
  await stubRun(t);

  // ---------- a stopped server: what its files say ----------
  await openCard('vanilla');
  await until(`${qa('.mcpl-row:not(.hidden)')}.length === 3`, 'the roster of a stopped server', 10000);
  check(await textOf('.mcset-state') === 'Stopped' && /stopped/.test(await textOf('.mcpl-banner')) && !await js(`${q('.mcpl-banner')}.classList.contains('hidden')`),
    'a stopped server says so above the player');
  const names = await js(`${qa('.mcpl-row:not(.hidden)')}.map((r) => r.dataset.name)`);
  check(S(names.slice().sort()) === S(['Alex', 'Griefer', 'Steve']), `the roster comes from usercache.json, ops, whitelist and bans (${S(names)})`);
  await press('.mcpl-start');
  await until(`window.__started.length === 1`, 'Start in the tab', 3000);
  const offWhileLaunching = await js(`${q('.mcpl-start')}.disabled`);
  await until(`!${q('.mcpl-start')}.disabled`, 'Start back after the launch', 3000);
  await toCards();
  await until(`!!document.querySelector('#minecraftScreen .mc-server[data-name="vanilla"] .mc-start')?.offsetParent`, 'the card\'s Start', 5000);
  await mouse(`document.querySelector('#minecraftScreen .mc-server[data-name="vanilla"] .mc-start')`);
  await until(`window.__started.length === 2`, 'Start on the card', 3000);
  const [fromTab, fromCard] = await js(`window.__started`);
  check(offWhileLaunching && S(fromTab) === S(fromCard) && fromTab.type === 'minecraft-server' && fromTab.dir === 'servers/vanilla', `Start in the banner hands over what the card's Start does, once (${S(fromTab)})`);
  await t.sleep(500);
  await openCard('vanilla');
  await choose('Steve');
  await section('inventory');
  await until(`/Saved data, read only/.test(${q('.mcpl-inv-note')}?.textContent)`, 'saved inventory note', 10000);
  const saved = await js(`({ count: ${qa('.mcpl-tile.filled')}.length, sword: ${q('.mcpl-tile[data-slot="0"]')}.dataset.id, stone: ${q('.mcpl-tile[data-slot="9"] .mcpl-count')}?.textContent,
    enchanted: ${q('.mcpl-tile[data-slot="0"]')}.classList.contains('enchanted'), helmet: ${q('.mcpl-tile[data-slot="103"]')}.dataset.id, offhand: ${q('.mcpl-tile[data-slot="-106"]')}.dataset.id,
    held: ${q('.mcpl-tile.held')}.dataset.slot, ender: ${q('.mcpl-tile[data-ender][data-slot="2"]')}.dataset.id, editable: ${qa('.mcpl-tile.editable')}.length })`);
  check(saved.count === 5 && saved.sword === 'minecraft:diamond_sword' && saved.stone === '64' && saved.enchanted && saved.helmet === 'minecraft:iron_helmet' && saved.offhand === 'minecraft:shield'
    && saved.held === '4' && saved.ender === 'minecraft:ender_pearl' && saved.editable === 0, `an offline player's inventory is read from the fixture .dat, and no slot can be edited (${S(saved)})`);
  await hover(q('.mcpl-tile[data-slot="0"]'));
  await until(`!!document.querySelector('.mcpl-tip')`, 'tooltip', 5000);
  const tip = await js(`document.querySelector('.mcpl-tip').textContent`);
  check(/Diamond Sword/.test(tip) && /Sharpness V/.test(tip) && /Durability 1554 \/ 1561/.test(tip) && /Hotbar 1/.test(tip), `the tooltip has the name, enchantments and durability (${tip})`);
  await press('.mcpl-tile[data-slot="0"]');
  await away();
  await t.sleep(100);
  check(await js(`!document.querySelector('.mcpl-tip') && !document.querySelector('.dialog')`), 'a read-only slot opens nothing');
  await section('overview');
  await until(`${q('[data-fact="deaths"] .mcpl-fact-value')}?.textContent === '3'`, 'stats', 5000);
  const facts = await js(`Object.fromEntries(${qa('.mcpl-fact')}.map((f) => [f.dataset.fact, f.querySelector('.mcpl-fact-value').textContent]))`);
  check(facts.state === 'Offline' && facts.pos === '100.5, 72.0, -40.2' && facts.dimension === 'The Nether' && facts.gamemode === 'Creative' && facts.health === '18.5' && facts.food === '17' && facts.xp === '30'
    && facts.playtime === '1 h 0 min' && facts.op === 'No' && facts.whitelist === 'Yes' && facts.ban === 'No' && facts.kills === '41' && facts.jumps === '900' && facts.advancements === '2',
  `the overview shows the saved state, stats and flags (${S(facts)})`);
  check(facts.first === 'Before records began' && facts.last === 'Before records began' && /No record/.test(await js(`${row('Steve')}.querySelector('.mcpl-row-sub').textContent`)),
    `play in the files with no record in this app does not read as never seen (${facts.first}, ${facts.last})`);
  const off = await js(`({ heal: ${q('.mcpl-q-heal')}.disabled, title: ${q('.mcpl-q-heal')}.title, op: ${q('.mcpl-q-op')}.disabled, line: !!${q('.mcpl-reason')}.offsetParent,
    sentence: [...${tabOf}.querySelectorAll('*')].filter((n) => n.offsetParent && !n.children.length && /The server is stopped/.test(n.textContent)).length })`);
  check(off.heal && off.op && /stopped/.test(off.title) && !off.line && off.sentence === 1, `actions are off, and the reason shows once (${S(off)})`);
  await shot('stopped-overview.png');
  await choose('Griefer');
  await section('inventory');
  await until(`/could not be read/.test(${q('.mcpl-inv-note')}?.textContent)`, 'damaged note', 10000);
  check(await js(`!!${q('.mcpl-inv-note')}.classList.contains('bad') && ${qa('.mcpl-tile')}.length === 0 && /Banned/.test(${q('.mcpl-flags')}.textContent)`), 'a damaged file says so, in the tab\'s own words, and a ban shows');
  await choose('Alex');
  await until(`/saved nothing/.test(${q('.mcpl-inv-note')}?.textContent)`, 'missing note', 10000);
  check(true, 'a player the server never saved says so');
  await choose('Steve');
  await section('overview');

  // ---------- a proxy, a long list ----------
  await openCard('proxy');
  await until(`!!${q('.mcpl-proxy')}`, 'proxy message', 10000);
  check(/proxy has no players/.test(await textOf('.mcpl-proxy')) && await js(`${qa('.mcpl-side, .mcpl-row, .mcpl-tab')}.length === 0`), 'a proxy shows its message and nothing else');
  const proxyBox = await js(`Math.round(${q('.mcpl-proxy')}.getBoundingClientRect().height)`);
  check(proxyBox < 90, `the proxy's note is as tall as its text (${proxyBox} px)`);
  await shot('proxy.png');
  const proxied = await start(t, 'proxy');
  await press('.mcpl-reload');
  await until(`${q('.mcset-state')}?.textContent === 'Running'`, 'a running proxy', 8000);
  await t.sleep(500);
  check(await js(`${q('.mcset-state')}.textContent === 'Running' && ${q('.mcset-state')}.classList.contains('on')`), 'a running proxy shows Running, not Starting');
  await shot('proxy-running.png');
  await js(`(ide.proc.input(${proxied}, 'stop\\n'), true)`);
  await until(`window.__exited?.includes(${proxied})`, 'the proxy gone', 8000);
  await js(`(ide.closeTab(ide.minecraft.players.tabId(${S(dirOf(await js('ide.root'), 'proxy'))}), true), true)`);
  await openCard('big');
  await until(`/3000 players/.test(${q('.mcset-sub')}?.textContent)`, 'the long list', 15000);
  const rows = await js(`${qa('.mcpl-row')}.length`);
  check(rows > 5 && rows < 80, `3000 players draw only the rows in sight (${rows})`);
  if (await folded()) await press('.mcpl-fold');
  await js(`(() => { const r = ${q('.mcpl-rows')}; r.scrollTop = r.scrollHeight; return true; })()`);
  await until(`!!${row('Player999')} || !!${row('Player2999')}`, 'the end of the list', 5000);
  await setValue('.mcpl-find', 'player2999');
  await until(`!!${row('Player2999')}`, 'a name found in the long list', 5000);
  await choose('Player2999');
  check(await textOf('.mcpl-uuid') === crowd[2999].uuid, 'the last of 3000 players is found and selected');
  await shot('long-list.png');
  await js(`(ide.closeTab(ide.minecraft.players.tabId(${S(dirOf(await js('ide.root'), 'big'))}), true), true)`);

  // ---------- a running server ----------
  await openCard('vanilla');
  await choose('Steve');
  // Counts what the tab asks for, from here on: it must follow pushes, not a timer.
  await js(`(() => { const real = ide.api; window.__calls = {}; ide.api = { ...real, invoke: (ch, ...a) => { window.__calls[ch] = (window.__calls[ch] || 0) + 1; return real.invoke(ch, ...a); } }; return true; })()`);
  const v = await start(t, 'vanilla');
  await until(`${q('.mcset-state')}?.textContent === 'Running'`, 'the state follows the push', 10000);
  check(await js(`${q('.mcpl-banner')}.classList.contains('hidden')`), 'the stopped banner goes away when the server runs');
  await pause(2500);
  check((await js(`window.__calls['players:list'] || 0`)) <= 2, 'an idle tab asks for nothing on a timer');
  await tell(t, v, 'join Steve');
  await until(`${row('Steve')}?.querySelector('.mc-dot')?.classList.contains('on')`, 'Steve online', 10000);
  check(await js(`${qa('.mcpl-row:not(.hidden)')}[0].dataset.name === 'Steve'`), 'who is on comes first');
  await until(`${q('[data-fact="state"] .mcpl-fact-value')}?.textContent === 'Online' && ${q('[data-fact="health"] .mcpl-fact-value')}?.textContent === '12.5'`, 'live detail', 10000);
  check(await js(`${q('[data-fact="pos"] .mcpl-fact-value')}.textContent`) === '10.5, 64.0, -3.2', 'position from the login line');
  check(await reached('vanilla', 'data get entity Steve Pos', 8000) && await reached('vanilla', 'data get entity Steve Dimension', 4000), 'an open tab has positions polled');
  await tell(t, v, 'move Steve 200 80 -300');
  await until(`${q('[data-fact="pos"] .mcpl-fact-value')}?.textContent === '200.0, 80.0, -300.0'`, 'position follows the polling', 10000);
  check(true, 'a new position reaches the overview through the push');
  check(await js(`${q('[data-fact="dimension"] .mcpl-fact-value')}.textContent`) === 'Overworld', 'the dimension comes with it');

  // ---------- live inventory, newer item format ----------
  await section('inventory');
  await until(`/Live from the server/.test(${q('.mcpl-inv-note')}?.textContent)`, 'live inventory', 10000);
  const live = await js(`({ count: ${qa('.mcpl-tile.filled')}.length, dirt: ${q('.mcpl-tile[data-slot="1"] .mcpl-count')}?.textContent, held: ${q('.mcpl-tile.held')}.dataset.slot, editable: ${qa('.mcpl-tile.editable')}.length,
    enderEditable: ${qa('.mcpl-tile[data-ender].editable')}.length, chest: ${q('.mcpl-tile[data-slot="102"]')}.dataset.id, offhand: ${q('.mcpl-tile[data-slot="-106"]')}.dataset.id })`);
  check(live.count === 6 && live.dirt === '32' && live.held === '1' && live.editable === 68 && live.enderEditable === 27 && live.chest === 'minecraft:diamond_chestplate' && live.offhand === 'minecraft:shield',
    `a live inventory in the [components] format: slots can be edited, the ender chest too (${S(live)})`);
  await until(`!!${q('.mcpl-tile[data-slot="0"] img')}`, 'the icon of a catalog item', 5000);
  const plain = await js(`({ icon: ${q('.mcpl-tile[data-slot="0"] img')}.src.startsWith('data:image/png'), word: ${q('.mcpl-tile[data-slot="102"] .mcpl-tile-id')}?.textContent, id: ${q('.mcpl-tile[data-slot="102"]')}.dataset.id })`);
  check(plain.icon && plain.word === 'DC' && plain.id === 'minecraft:diamond_chestplate', `an item in the catalog shows its icon, one not in it a short word (${S(plain)})`);
  await hover(q('.mcpl-tile[data-slot="102"]'));
  await until(`/minecraft:diamond_chestplate/.test(document.querySelector('.mcpl-tip')?.textContent)`, 'the tooltip of an item with no icon', 5000);
  check(!/Diamond Chestplate/.test(await js(`document.querySelector('.mcpl-tip').textContent`)), 'the tooltip gives the id of an item outside the catalog, not a made-up name');
  const bar = await js(`(() => { const b = ${q('.mcpl-tile[data-slot="0"] .mcpl-durability')}.getBoundingClientRect(); const f = ${q('.mcpl-tile[data-slot="0"] .mcpl-durability i')}; return { share: f.getBoundingClientRect().width / b.width, colour: getComputedStyle(f).backgroundColor, none: !${q('.mcpl-tile[data-slot="1"] .mcpl-durability')} }; })()`);
  check(Math.abs(bar.share - (1561 - 1200) / 1561) < 0.03 && bar.none, `a damaged tool has a durability bar of the share it has left, and a stack has none (${S(bar)})`);
  const shape = await js(`getComputedStyle(${q('.mcpl-equip .mcpl-tile[data-slot="103"]')}, '::before').backgroundImage`);
  check(shape.includes('image/svg+xml'), 'an empty equipment slot draws the shape of what it takes');
  await hover(q('.mcpl-tile[data-slot="9"]'));
  await until(`!!document.querySelector('.mcpl-tip [data-user-text]')`, 'tooltip of a named item', 5000);
  const hostile = await js(`({ text: document.querySelector('.mcpl-tip').textContent, imgs: document.querySelectorAll('.mcpl-tip img').length, pwned: window.__pwned ?? null, marked: document.querySelectorAll('.mcpl-tip [data-user-text]').length })`);
  await away();
  check(hostile.text.includes('<img src=x') && hostile.imgs === 0 && hostile.pwned === null && hostile.marked === 1, `an item's name in the tooltip is only text, and the only line marked as a stranger's (${S(hostile)})`);
  await shot('inventory.png');

  // ---------- the console ----------
  await pause(1200);
  const quiet = await consoleOf(t, v);
  check(/Done \(0\.4s\)/.test(quiet) && /Steve joined the game/.test(quiet), 'the console shows the server\'s own lines');
  check(!/has the following entity data/.test(quiet) && !/There are \d+ of a max/.test(quiet), 'the console does not show the app\'s queries');
  check(logOf('vanilla').filter((l) => l.startsWith('data get')).length >= 3, 'although those queries reached the server');
  check(!/203\.0\.113\.7/.test(S(await js(`ide.api.invoke('players:search', ide.root, ${S(dirOf(await js('ide.root'), 'vanilla'))}, {})`))), 'the full IP is not stored');

  // ---------- timeline ----------
  await say(t, v, '<Steve> hello there');
  await say(t, v, '[Not Secure] <Steve> unsigned hello');
  await say(t, v, 'Steve was slain by Zombie');
  await say(t, v, 'Steve has made the advancement [Stone Age]');
  await say(t, v, 'Steve issued server command: /help');
  await section('timeline');
  await until(`${qa('.mcpl-event')}.length >= 6`, 'timeline events', 10000);
  const events = await js(`${qa('.mcpl-event')}.map((e) => [e.dataset.type, e.querySelector('.mcpl-event-text').textContent])`);
  check(S(events.map((e) => e[0])) === S(['command', 'advancement', 'death', 'chat', 'chat', 'join']), `the timeline is newest first (${S(events)})`);
  check(events[5][1].startsWith('Joined at 10.5') && await js(`${qa('.mcpl-ip')}[0]?.textContent === '203.0.*.*' && ${qa('.mcpl-event')}[3].textContent.includes('Unsigned')`), 'a join has its place and a masked IP, unsigned chat is marked');
  await press('.mcpl-chip[data-type="death"]');
  await until(`${qa('.mcpl-event')}.length === 1`, 'filter by type', 5000);
  check(await js(`${qa('.mcpl-event')}[0].dataset.type === 'death'`), 'the timeline filters by type');
  await press('.mcpl-chip[data-type="death"]');
  await setValue('.mcpl-tl-search', 'HELLO');
  await until(`${qa('.mcpl-event')}.length === 2`, 'timeline search', 5000);
  check(true, 'the timeline searches its text, any case');
  await say(t, v, '<Steve> hello while filtered');
  await until(`${qa('.mcpl-event')}.length === 3 && ${q('.mcpl-tl-search')}.value === 'HELLO'`, 'a pushed event under a filter', 5000);
  check(await js(`${qa('.mcpl-event-text')}[0].textContent`) === 'hello while filtered', 'a new event comes in on top, the search box keeping what was typed');
  await setValue('.mcpl-tl-search', '');
  await tell(t, v, 'burst Steve 130');
  await until(`${qa('.mcpl-event')}.length >= 100 && !${q('.mcpl-more')}.classList.contains('hidden')`, 'a long timeline', 10000);
  await until(`${qa('.mcpl-event-text')}[0]?.textContent === 'line 130'`, 'the last line of the burst', 5000);
  const first = await js(`${qa('.mcpl-event')}.length`);
  await press('.mcpl-more');
  await until(`${qa('.mcpl-event')}.length > ${first} && ${q('.mcpl-more')}.classList.contains('hidden')`, 'load more', 5000);
  const all = await js(`${qa('.mcpl-event-text')}.map((e) => e.textContent)`);
  check(all.length === 137 && new Set(all.filter((x) => x.startsWith('line '))).size === 130 && all.at(-1).startsWith('Joined'), `Load More reaches the first event without a repeat (${all.length})`);

  // ---------- forged lines ----------
  const before = await js(`${qa('.mcpl-event')}.length`);
  await say(t, v, '<Steve> Steve left the game');
  await say(t, v, '[Not Secure] <Steve> Steve lost connection: Disconnected');
  await say(t, v, '<Steve> Alex joined the game');
  await say(t, v, '<Steve> Stopping the server');
  await say(t, v, '<Steve> <img src=x onerror=window.__pwned=2>');
  await until(`${qa('.mcpl-event')}.length === ${before + 5}`, 'forged lines recorded as chat', 5000);
  const forged = await js(`({ types: [...new Set(${qa('.mcpl-event')}.slice(0, 5).map((e) => e.dataset.type))], imgs: ${qa('.mcpl-events img')}.length, text: ${qa('.mcpl-event-text')}[0].textContent, pwned: window.__pwned ?? null })`);
  check(S(forged.types) === S(['chat']) && forged.imgs === 0 && forged.text.startsWith('<img') && forged.pwned === null, `chat that looks like server lines stays chat, and shows as text (${S(forged)})`);
  await pause(500);
  const state = await js(`({ steve: ${row('Steve')}.querySelector('.mc-dot').classList.contains('on'), alex: ${row('Alex')}.querySelector('.mc-dot').classList.contains('on'), chip: ${q('.mcset-state')}.textContent })`);
  check(state.steve && !state.alex && state.chip === 'Running', `forged lines change nobody's state (${S(state)})`);
  await tell(t, v, 'delay 700');
  await section('inventory');
  await js(`(${q('.mcpl-reload')}.click(), true)`);
  await pause(150);
  await say(t, v, '<Steve> Steve has the following entity data: {Health: 1.0f, Inventory: []}');
  await say(t, v, '[Not Secure] <Steve> Steve has the following entity data: {Health: 2.0f, Inventory: []}');
  await pause(1100);
  check(await js(`${qa('.mcpl-tile.filled')}.length === 6 && ${q('[data-fact="health"] .mcpl-fact-value')}.textContent === '12.5'`), 'chat cannot stand in for a query\'s answer');
  await tell(t, v, 'delay 0');

  // ---------- give and clear, with what reached the server ----------
  await section('actions');
  await press('.mcpl-give-item');
  await until(`${pickRows}.length === 5`, 'a press opens the list, with no query', 8000);
  await type('diamond');
  await until(`${pickRows}.length === 2`, 'item search', 8000);
  const picks = await js(`${pickRows}.map((p) => [p.dataset.id, p.querySelector('.mcpl-pick-name').textContent, !!p.querySelector('img')])`);
  check(picks[0][0] === 'minecraft:diamond' && picks[1][1] === 'Diamond Sword' && picks[1][2], `give searches the catalog, with names and icons (${S(picks)})`);
  await t.press('ArrowDown');
  await t.press('ArrowDown');
  await t.press('ArrowUp');
  check(await js(`${pickRows}[0].classList.contains('active') && !${pickRows}[1].classList.contains('active')`), 'the arrows walk the list');
  await mouse(pickRow('minecraft:diamond_sword'));
  await until(`!document.querySelector('.mcpl-picks')`, 'the list closed by a pick', 2000);
  const chosen = await js(`({ name: ${q('.mcpl-give .mcpl-chosen-name')}?.textContent, id: ${q('.mcpl-give .mcpl-chosen-id')}?.textContent, icon: !!${q('.mcpl-give .mcpl-chosen img')}, shown: !!${q('.mcpl-give .mcpl-chosen')}.offsetParent, focus: document.activeElement === ${q('.mcpl-give-item')} })`);
  check(chosen.name === 'Diamond Sword' && chosen.id === 'minecraft:diamond_sword' && chosen.icon && chosen.shown && chosen.focus, `a pick shows in the box by name and icon, with the id beneath (${S(chosen)})`);
  await setValue('.mcpl-give-count', '2');
  await press('.mcpl-give .mcpl-enchant-add');
  await press('.mcpl-give .mcpl-enchant-id');
  await type('sharp');
  await until(`${pickRows}.length === 1`, 'enchantment search', 5000);
  await t.press('Enter');
  check(await js(`${q('.mcpl-give .mcpl-enchant .mcpl-chosen-name')}?.textContent`) === 'Sharpness', 'an enchantment is found by name, and Enter picks it');
  await setValue('.mcpl-give .mcpl-enchant-level', '5');
  await shot('actions.png');
  const gave = await resultOf(() => press('.mcpl-give-go'));
  const giveLine = 'give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5}}] 2';
  check(await reached('vanilla', giveLine), 'give reaches the server as the exact 1.20.5 to 1.21.4 command');
  check(gave.includes('Gave 2 of Diamond Sword to Steve.') && gave.includes(`> ${giveLine}`) && gave.includes('Gave 2 [Diamond Sword] to Steve'), `the result says what happened, with the command and the server's answer folded away (${gave})`);
  const folds = await js(`({ tint: ${q('.mcpl-result')}.classList.contains('ok'), hidden: !${q('.mcpl-result-commands')}.checkVisibility(), colour: getComputedStyle(${q('.mcpl-result')}).backgroundColor })`);
  await press('.mcpl-result-more > summary');
  check(folds.tint && folds.hidden && await js(`${q('.mcpl-result-commands')}.checkVisibility()`), `the details open on a press (${S(folds)})`);
  await shot('result.png');
  await pause(9000);
  check(await js(`!${q('.mcpl-result')}.classList.contains('hidden')`), 'a success someone is reading stays');
  await press('.mcpl-result-close');
  const sent = sentBy('vanilla').length;
  await press('.mcpl-clear-all');
  await until(`/whole inventory of Steve/.test(${lastDialog}?.textContent)`, 'clear asks first', 5000);
  await answer('Cancel');
  await pause(300);
  check(sentBy('vanilla').length === sent, 'clear asks first, and Cancel sends nothing');
  const cleared = await resultOf(async () => { await press('.mcpl-clear-all'); await answer('Clear Everything'); });
  check(await reached('vanilla', 'clear Steve') && /Removed 3 item\(s\)/.test(cleared) && /Emptied the whole inventory of Steve/.test(cleared), `Clear Everything sends clear Steve (${cleared})`);
  await until(`${q('.mcpl-result')}.classList.contains('hidden')`, 'a success goes by itself', 10000);
  check(true, 'a success fades by itself');
  const noItem = await resultOf(() => press('.mcpl-clear-one'));
  check(/Choose an item/.test(noItem) && /Steve/.test(noItem) && await js(`!document.querySelector('.dialog') && ${q('.mcpl-result')}.classList.contains('bad')`), `clearing one item with none chosen says so, without asking about nothing (${noItem})`);
  await pause(9000);
  check(await js(`!${q('.mcpl-result')}.classList.contains('hidden')`), 'a failure stays');
  await press('.mcpl-give .mcpl-field:has(.mcpl-enchant-add) .mcpl-field-label');
  check(await js(`${qa('.mcpl-give .mcpl-enchant')}.length`) === 1, 'a click on a field\'s name does not press the button under it');
  await press('.mcpl-clear-item');
  await type('dirt');
  await until(`${pickRows}.length === 1`, 'the item to clear', 5000);
  await mouse(pickRow('minecraft:dirt'));
  await setValue('.mcpl-clear-count', '5');
  await press('.mcpl-clear-one');
  await until(`/Remove Dirt from the inventory of Steve/.test(${lastDialog}?.textContent)`, 'the question names the item', 5000);
  await resultOf(() => answer('Clear'));
  check(await reached('vanilla', 'clear Steve minecraft:dirt 5'), 'clearing one item asks by name, and sends its id and count');
  await press('.mcpl-clear-item');
  await type('zzzzz');
  await until(`/No item matches/.test(document.querySelector('.mcpl-picks .mcpl-pick-note')?.textContent)`, 'no match', 5000);
  await shot('no-match.png');
  check(await js(`${pickRows}.length === 0 && document.querySelector('.mcpl-picks').checkVisibility()`), 'a search with no match says so');
  const named = sentBy('vanilla').length;
  const unknown = await resultOf(() => press('.mcpl-clear-one'));
  check(/not an item id/.test(unknown) && await js(`!document.querySelector('.dialog')`) && sentBy('vanilla').length === named, `a name nobody picked is refused before any question (${unknown})`);
  const badItem = await resultOf(async () => { await setValue('.mcpl-give-item', 'NOT AN ID!'); await press('.mcpl-give-go'); });
  check(/not an item id/.test(badItem) && !sentBy('vanilla').some((l) => l.includes('NOT AN ID')), `a bad id is refused with the tab's own text, and nothing is sent (${badItem})`);
  const nope = await resultOf(async () => { await setValue('.mcpl-give-item', 'minecraft:nope'); await press('.mcpl-give-go'); });
  const nopeOpen = await js(`${q('.mcpl-result')}.classList.contains('bad') && getComputedStyle(${q('.mcpl-result')}).backgroundColor !== ${S(folds.colour)}`);
  check(nopeOpen && /The server refused this/.test(nope) && /Give Item · 'Steve'/.test(nope) && /Unknown item/.test(nope), `what the server refuses shows as refused, for that player, with its answer (${nope})`);
  await press('.mcpl-give .mcpl-enchant-remove');
  await press('.mcpl-give-count');
  await setValue('.mcpl-give-item', 'minecraft:stick');
  await setValue('.mcpl-give-count', '3');
  await t.press('Enter');
  check(await reached('vanilla', 'give Steve minecraft:stick 3'), 'Enter in the Give form presses Give');
  await until(`!${q('.mcpl-result')}.classList.contains('sending')`, 'the result of Enter', 5000);

  // ---------- every other action ----------
  const simple = [
    ['.mcpl-mode-go', 'gamemode survival Steve', null], ['.mcpl-effect-clear', 'effect clear Steve', null],
  ];
  for (const [button, line] of simple) { await resultOf(() => press(button)); check(await reached('vanilla', line), `${button} sends ${line}`); }
  const healed = await resultOf(() => press('.mcpl-heal'));
  check(await reached('vanilla', 'effect give Steve minecraft:instant_health 1 10 true') && /does not revive/.test(healed) && /Healed Steve/.test(healed), `Heal sends its effect, and the tab says what it does not do (${healed})`);
  await resultOf(() => press('.mcpl-feed'));
  check(await reached('vanilla', 'effect give Steve minecraft:saturation 1 19 true'), 'Feed sends its effect');
  const noEffect = await resultOf(() => press('.mcpl-effect-go'));
  check(/Choose an effect/.test(noEffect), `an effect with none chosen says so (${noEffect})`);
  await press('.mcpl-effect-id');
  await until(`${pickRows}.length === 3`, 'the effects', 5000);
  await type('spe');
  await until(`${pickRows}.length === 1`, 'effect search', 5000);
  await mouse(pickRow('minecraft:speed'));
  await setValue('.mcpl-effect-seconds', '60');
  await setValue('.mcpl-effect-amplifier', '2');
  const effected = await resultOf(() => press('.mcpl-effect-go'));
  check(await reached('vanilla', 'effect give Steve minecraft:speed 60 2 false') && /Gave Speed to Steve/.test(effected), `an effect with its time and strength (${effected})`);
  await press('.mcpl-effect-forever');
  await press('.mcpl-effect-hide');
  await resultOf(() => press('.mcpl-effect-go'));
  check(await reached('vanilla', 'effect give Steve minecraft:speed infinite 2 true'), 'an endless effect with hidden particles');
  await press('.mcpl-effect .mcpl-chosen-clear');
  await resultOf(() => press('.mcpl-effect-clear'));
  await setValue('.mcpl-tp-x', '1.5');
  await setValue('.mcpl-tp-y', '70');
  await setValue('.mcpl-tp-z', '-8');
  const moved = await resultOf(() => press('.mcpl-tp-here'));
  check(await reached('vanilla', 'tp Steve 1.5 70 -8') && /Moved Steve to 1\.5, 70, -8/.test(moved), `teleport to coordinates (${moved})`);
  const alone = await js(`({ off: ${q('.mcpl-tp-player')}.disabled, title: ${q('.mcpl-tp-player')}.title, line: ${q('.mcpl-tp-why')}.textContent, seen: !!${q('.mcpl-tp-why')}.offsetParent })`);
  check(alone.off && /No other player/.test(alone.title) && alone.seen && /No other player/.test(alone.line), `Teleport to Player is off with a reason when nobody else is on (${S(alone)})`);
  await tell(t, v, 'join Alex');
  await until(`${q('.mcpl-tp-to')}?.options.length === 1`, 'the other online player', 8000);
  await until(`!${q('.mcpl-tp-player')}.disabled && !${q('.mcpl-tp-why')}.offsetParent`, 'teleport on with someone to go to', 5000);
  await resultOf(() => press('.mcpl-tp-player'));
  check(await reached('vanilla', 'tp Steve Alex'), 'teleport to a player');
  await setValue('.mcpl-whisper-text', 'hi there');
  await resultOf(() => press('.mcpl-whisper-go'));
  check(await reached('vanilla', 'msg Steve hi there') && await js(`${q('.mcpl-whisper-text')}.value === ''`), 'a whisper is sent, and its box empties');
  const emptyWhisper = await resultOf(() => press('.mcpl-whisper-go'));
  check(/empty or too long/.test(emptyWhisper), `an empty whisper is refused before it is sent (${emptyWhisper})`);
  await resultOf(async () => { await press('.mcpl-op'); await until(`/an operator/.test(${lastDialog}?.textContent)`, 'op asks first', 5000); await answer('Make Operator'); });
  check(await reached('vanilla', 'op Steve'), 'op asks first, then sends');
  await until(`/Operator 4/.test(${q('.mcpl-flags')}?.textContent)`, 'the operator chip', 8000);
  check(true, 'the flag follows ops.json');
  await resultOf(() => press('.mcpl-deop'));
  check(await reached('vanilla', 'deop Steve'), 'deop');
  await resultOf(() => press('.mcpl-deny'));
  check(await reached('vanilla', 'whitelist remove Steve'), 'whitelist remove');
  await resultOf(() => press('.mcpl-allow'));
  check(await reached('vanilla', 'whitelist add Steve'), 'whitelist add');

  // ---------- slots ----------
  await lostClicks(t, helpers(t), 'code', 'Steve', 'vanilla');
  await section('inventory');
  await until(`${q('.mcpl-tile[data-slot="0"]')}?.classList.contains('editable')`, 'an editable slot', 8000);
  await press('.mcpl-tile[data-slot="0"]');
  await until(`!!document.querySelector('.dialog .mcpl-slot-item')`, 'the slot dialog', 5000);
  await shot('slot-dialog.png');
  await js(`(() => { const i = document.querySelector('.dialog .mcpl-slot-item'); i.value = '다이아몬드 검'; i.dispatchEvent(new Event('input')); return true; })()`);
  await answer('Replace');
  check(await js(`/not an item id/.test(document.querySelector('.dialog .mc-dialog-error').textContent) && document.querySelectorAll('.dialog').length === 1`), 'a slot takes no name nobody picked: it says so in the dialog, before any question');
  await js(`(() => { const i = document.querySelector('.dialog .mcpl-slot-item'); i.value = 'minecraft:stone'; i.dispatchEvent(new Event('input')); return true; })()`);
  const placed = await resultOf(async () => { await answer('Replace'); await until(`/Replace what Steve holds/.test(${lastDialog}?.textContent)`, 'replacing asks first', 5000); await answer('Replace'); });
  check(await reached('vanilla', 'item replace entity Steve hotbar.0 with minecraft:stone 1') && /Put 1 of .* in Hotbar 1 of Steve/.test(placed), `a slot is replaced with the item command, after asking (${placed})`);
  await until(`!document.querySelector('.dialog')`, 'dialogs closed', 5000);
  await until(`${q('.mcpl-tile[data-slot="1"]')}?.classList.contains('editable')`, 'the next slot', 8000);
  await press('.mcpl-tile[data-slot="1"]');
  await until(`!!document.querySelector('.dialog .mcpl-slot-item')`, 'the slot dialog again', 5000);
  await resultOf(async () => { await answer('Empty Slot'); await until(`/Empty Hotbar 2 of Steve/.test(${lastDialog}?.textContent)`, 'emptying asks first', 5000); await answer('Empty Slot'); });
  check(await reached('vanilla', 'item replace entity Steve hotbar.1 with minecraft:air 1'), 'a slot is emptied with air, after asking');
  await until(`!document.querySelector('.dialog')`, 'dialogs closed', 5000);
  await until(`${q('.mcpl-tile[data-slot="-106"]')}?.classList.contains('editable')`, 'the offhand slot', 8000);
  await press('.mcpl-tile[data-slot="-106"]');
  await until(`!!document.querySelector('.dialog .mcpl-slot-item')`, 'the offhand dialog', 5000);
  await js(`(() => { const i = document.querySelector('.dialog .mcpl-slot-item'); i.value = 'minecraft:torch'; i.dispatchEvent(new Event('input')); return true; })()`);
  await resultOf(async () => { await answer('Replace'); await answer('Replace'); });
  check(await reached('vanilla', 'item replace entity Steve weapon.offhand with minecraft:torch 1'), 'the offhand has its slot name');
  await until(`!document.querySelector('.dialog')`, 'dialogs closed', 5000);

  // ---------- kick and ban ----------
  await section('overview');
  await choose('Alex');
  const kicked = await resultOf(async () => { await press('.mcpl-q-kick'); await until(`/Kick Alex from the server/.test(${lastDialog}?.textContent)`, 'kick asks first', 5000); await answer('Kick'); });
  check(await reached('vanilla', 'kick Alex') && /Kicked Alex/.test(kicked), `a quick kick asks first, then sends (${kicked})`);
  await until(`!${row('Alex')}?.querySelector('.mc-dot').classList.contains('on')`, 'Alex gone', 8000);
  await until(`${q('.mcpl-q-kick')}.disabled && /is offline/.test(${q('.mcpl-q-kick')}.title)`, 'kick off for an offline player', 5000);
  check(await js(`!${q('.mcpl-q-ban')}.disabled`), 'an offline player can still be banned, but not kicked');
  await section('actions');
  await setValue('.mcpl-reason-text', 'griefing again');
  await resultOf(async () => { await press('.mcpl-ban'); await until(`/Ban Alex from the server/.test(${lastDialog}?.textContent)`, 'ban asks first', 5000); await answer('Ban'); });
  check(await reached('vanilla', 'ban Alex griefing again'), 'ban sends its reason');
  await until(`/Banned/.test(${q('.mcpl-flags')}?.textContent)`, 'the ban chip', 8000);
  await resultOf(() => press('.mcpl-pardon'));
  check(await reached('vanilla', 'pardon Alex'), 'pardon');
  const listed = await resultOf(() => press('.mcpl-allow'));
  check(await js(`!${q('.mcpl-result')}.classList.contains('hidden')`) && /Added Alex to the whitelist/.test(listed), `a result names its player (${listed})`);
  await choose('Griefer');
  check(await js(`${q('.mcpl-result')}.classList.contains('hidden')`), 'a result goes when another player is chosen');
  await choose('Alex');
  await section('overview');
  await resultOf(() => press('.mcpl-q-deny'));
  await section('timeline');
  check(await js(`${q('.mcpl-result')}.classList.contains('hidden')`), 'a result stays behind when the section changes');
  await section('actions');
  await resultOf(() => press('.mcpl-allow'));

  // ---------- search and the admin log ----------
  await press('.mcpl-open-search');
  await until(`${q('.mcpl-search')} && !${q('.mcpl-search')}.classList.contains('hidden')`, 'the search page', 5000);
  check(await js(`${q('.mcpl-result')}.classList.contains('hidden')`), 'a result stays behind when the page changes');
  await setValue('.mcpl-all-search', 'unsigned hello');
  await until(`${qa('.mcpl-search .mcpl-event')}.length === 1`, 'search across players', 8000);
  await shot('search.png');
  // A search takes its time here, and chat keeps coming: searches must not pile up behind each other.
  await js(`(() => { const real = ide.api.invoke; window.__invoke = real; window.__search = { now: 0, most: 0, count: 0 }; ide.api.invoke = async (ch, ...a) => {
    if (ch !== 'players:search') return real(ch, ...a);
    const s = window.__search; s.now += 1; s.count += 1; s.most = Math.max(s.most, s.now);
    try { await new Promise((r) => { setTimeout(r, 700); }); return await real(ch, ...a); } finally { s.now -= 1; }
  }; return true; })()`);
  await setValue('.mcpl-all-search', '');
  await until(`window.__search.count > 0 && window.__search.now === 0`, 'the search over a slow store', 8000);
  await js(`(window.__search.count = 0, true)`);
  for (let i = 0; i < 12; i++) { await say(t, v, `<Steve> busy line ${i}`); await pause(170); }
  await until(`${qa('.mcpl-search .mcpl-event-text')}[0]?.textContent === 'busy line 11'`, 'the last line reaches the search page', 10000);
  const busy = await js(`window.__search`);
  check(busy.most === 1 && busy.count >= 1 && busy.count <= 5, `12 pushes in 2 s run one search at a time, with the last line shown (${S(busy)})`);
  await js(`(ide.api.invoke = window.__invoke, true)`);
  await setValue('.mcpl-all-search', 'unsigned hello');
  await until(`${qa('.mcpl-search .mcpl-event')}.length === 1`, 'search across players again', 8000);
  await press('.mcpl-search .mcpl-link');
  await until(`${q('.mcpl-name')}?.textContent === 'Steve' && !${q('.mcpl-timeline')}.classList.contains('hidden') && ${q('.mcpl-search')}.classList.contains('hidden')`, 'a result opens the player', 8000);
  check(true, 'a search result opens that player\'s timeline');
  await press('.mcpl-open-log');
  await until(`${qa('.mcpl-log-row')}.length >= 15`, 'the admin log', 8000);
  const log = await js(`${qa('.mcpl-log-row')}.map((r) => r.textContent)`);
  check(log.some((l) => l.includes('Give Item') && l.includes(giveLine) && l.includes('Gave 2')) && log.some((l) => l.includes('Unknown item') && l.includes('Failed')) && log.some((l) => l.includes('Ban') && l.includes('griefing again')),
    `the admin log has each action with its commands and answer (${log.length} rows)`);
  check(log.some((l) => l.includes('Whisper') && l.includes('Failed') && l.includes('empty or too long')), 'an action refused before sending has its reason in the admin log');
  await shot('admin-log.png');
  await choose('Steve');

  // ---------- a server that stops answering, then dies ----------
  await section('inventory');
  await tell(t, v, 'hang');
  await section('actions');
  await setValue('.mcpl-give-item', 'minecraft:dirt');
  const quietResult = await resultOf(async () => {
    await press('.mcpl-give-go');
    await pause(300);
    const waiting = await js(`({ text: ${q('.mcpl-result')}.textContent, tint: ${q('.mcpl-result')}.classList.contains('sending'), seen: !!${q('.mcpl-result')}.offsetParent, offs: ${qa('.mcpl-give-go, .mcpl-heal, .mcpl-mode-go, .mcpl-kick, .mcpl-op')}.map((b) => b.disabled) })`);
    await shot('sending.png');
    check(/Sending to the server/.test(waiting.text) && /Steve/.test(waiting.text) && waiting.tint && waiting.seen && waiting.offs.every(Boolean), `while an action waits the bar says so and the buttons are off (${S(waiting)})`);
  });
  check(/Sent\. The server said nothing back\./.test(quietResult) && await js(`${q('.mcpl-result')}.classList.contains('warn') && !${q('.mcpl-give-go')}.disabled`), `a silent server: sent, no answer, and the buttons are back (${quietResult})`);
  await section('inventory');
  await js(`(${q('.mcpl-reload')}.click(), true)`);
  // Up to two queries of 5 s each: the one after the action, then this one, behind any position query already waiting.
  await until(`/gave no live data/.test(${q('.mcpl-inv-note')}?.textContent)`, 'the last save when the server is silent', 16000);
  check(await js(`${qa('.mcpl-tile.editable')}.length === 0 && ${qa('.mcpl-tile.filled')}.length === 5`), 'a silent server leaves the saved file, read only');
  await section('actions');
  const died = await resultOf(async () => { await press('.mcpl-give-go'); await pause(100); await tell(t, v, 'die'); });
  check(/stopped before it answered/.test(died) || /not running/.test(died), `an action in flight when the server dies says so (${died})`);
  await until(`${q('.mcset-state')}?.textContent === 'Stopped'`, 'the server is gone', 8000);
  await until(`${q('.mcpl-give-go')}.disabled && /stopped/.test(${q('.mcpl-give-go')}.title)`, 'actions off after the crash', 5000);
  check(true, 'a dead server turns the actions off, with the reason');
  await until(`!${row('Steve')}?.querySelector('.mc-dot').classList.contains('on')`, 'nobody online after the crash', 5000);
  const late = await js(`ide.api.invoke('players:action', ide.root, ${S(dirOf(await js('ide.root'), 'vanilla'))}, { type: 'kick', target: 'Steve' })`);
  check(late.ok === false && late.code === 'notRunning', `an action on a dead server comes back as a value (${S(late)})`);
  await section('timeline');
  await until(`${qa('.mcpl-event-text')}[0]?.textContent === 'Left when the server stopped'`, 'the leave of a crash', 8000);
  check(true, 'the crash ends the session in the timeline, in the tab\'s own words');
  await section('overview');
  await shot('after-crash.png');

  // ---------- the other kinds ----------
  const KINDS = [
    ['paper', 'give Steve minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]} 2', { tile: 'minecraft:netherite_sword', enchant: 'Looting III', name: 'Oathbreaker', dimension: 'The End' }],
    ['fabric', 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}] 2', { tile: 'minecraft:bow', slot: 3, enchant: 'Power IV', name: 'Longshot', dimension: 'The Nether', offhand: 'minecraft:torch', head: 'minecraft:turtle_helmet' }],
    ['forge', 'give Steve minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]} 2', { tile: 'minecraft:netherite_sword', enchant: 'Looting III', name: 'Oathbreaker', dimension: 'The End' }],
  ];
  for (const [kind, line, want] of KINDS) {
    await openCard(kind);
    const id = await start(t, kind);
    if (SERVERS[kind].slowStart) {
      await press('.mcpl-reload');
      await until(`${q('.mcset-state')}?.textContent === 'Starting'`, `${kind} starting`, 10000);
      const rising = await js(`({ banner: ${q('.mcpl-banner-text')}.textContent, start: !!${q('.mcpl-start')}.offsetParent })`);
      check(/starting/.test(rising.banner) && !rising.start, `a server on its way up says so, and offers no Start (${S(rising)})`);
      await tell(t, id, 'up');
    }
    await until(`${q('.mcset-state')}?.textContent === 'Running'`, `${kind} running`, 10000);
    await tell(t, id, 'join Steve');
    await until(`${row('Steve')}?.querySelector('.mc-dot')?.classList.contains('on')`, `Steve on ${kind}`, 10000);
    await say(t, id, '<Steve> hello');
    await say(t, id, 'Steve fell from a high place');
    await say(t, id, '<Steve> Steve left the game');
    await choose('Steve');
    await section('timeline');
    await until(`${qa('.mcpl-event')}.length === 4`, `the timeline of ${kind}`, 8000);
    const types = await js(`${qa('.mcpl-event')}.map((e) => e.dataset.type)`);
    check(S(types) === S(['chat', 'death', 'chat', 'join']), `${kind}: its log lines become events (${S(types)})`);
    await section('inventory');
    const slot = want.slot ?? 0;
    await until(`${q(`.mcpl-tile[data-slot="${slot}"]`)}?.dataset.id === ${S(want.tile)}`, `the live inventory of ${kind}`, 8000);
    await hover(q(`.mcpl-tile[data-slot="${slot}"]`));
    await until(`!!document.querySelector('.mcpl-tip')`, 'tooltip', 5000);
    const shown = await js(`document.querySelector('.mcpl-tip').textContent`);
    await away();
    check(shown.includes(want.enchant) && shown.includes(want.name), `${kind} ${SERVERS[kind].mc}: the item format of this version is read (${shown})`);
    if (kind === 'paper') {
      await hover(q('.mcpl-tile[data-slot="1"]'));
      await until(`/laser_drill/.test(document.querySelector('.mcpl-tip')?.textContent)`, 'the tooltip of a mod\'s tool', 5000);
      const worn = await js(`({ tip: document.querySelector('.mcpl-tip').textContent, bar: ${q('.mcpl-tile[data-slot="1"] .mcpl-durability')}.classList.contains('unknown'), word: ${q('.mcpl-tile[data-slot="1"] .mcpl-tile-id')}.textContent })`);
      await away();
      check(/Durability worn by 12/.test(worn.tip) && worn.bar && worn.word === 'LD', `a tool of unknown maximum says what wear it knows, with a bar that claims no share (${S(worn)})`);
    }
    if (want.offhand) check(await js(`${q('.mcpl-tile[data-slot="-106"]')}.dataset.id === ${S(want.offhand)} && ${q('.mcpl-tile[data-slot="103"]')}.dataset.id === ${S(want.head)}`), `${kind}: armor and offhand from equipment`);
    await section('overview');
    await until(`${q('[data-fact="dimension"] .mcpl-fact-value')}?.textContent === ${S(want.dimension)}`, `the dimension on ${kind}`, 8000);
    await section('actions');
    await setValue('.mcpl-give-item', 'minecraft:diamond_sword');
    await setValue('.mcpl-give-count', '2');
    await press('.mcpl-give .mcpl-enchant-add');
    await setValue('.mcpl-give .mcpl-enchant-id', 'minecraft:sharpness');
    await setValue('.mcpl-give .mcpl-enchant-level', '5');
    await resultOf(() => press('.mcpl-give-go'));
    check(await reached(kind, line), `${kind} ${SERVERS[kind].mc}: give in this version's format reaches the server`);
    if (kind === 'paper') {
      await setValue('.mcpl-give-item', '');
      await js(`(() => { const real = ide.api.invoke; window.__invoke = real; ide.api.invoke = async (ch, ...a) => { if (ch === 'players:items') await new Promise((r) => { setTimeout(r, 700); }); return real(ch, ...a); }; return true; })()`);
      await press('.mcpl-give-item');
      await type('dia');
      await until(`/Looking up items/.test(document.querySelector('.mcpl-picks .mcpl-pick-note')?.textContent)`, 'the note while a slow catalog answers', 3000);
      check(true, 'a first search that waits on the catalog says so');
      await until(`/could not be downloaded/.test(document.querySelector('.mcpl-picks .mcpl-pick-note')?.textContent)`, 'the catalog\'s reason', 8000);
      await js(`(ide.api.invoke = window.__invoke, true)`);
      check(await js(`${pickRows}.length === 0`), 'with no cache and no network the item box says why and takes an id');
      await t.press('Escape');
    }
    await js(`(ide.proc.input(${id}, 'stop\\n'), true)`);
    await until(`${q('.mcset-state')}?.textContent === 'Stopped'`, `${kind} stopped`, 8000);
    await js(`(ide.closeTab(ide.minecraft.players.tabId(${S(dirOf(await js('ide.root'), kind))}), true), true)`);
  }
  // ---------- 26.3: answers and broadcasts behind `System chat: ` ----------
  await openCard('modern');
  const modern = await start(t, 'modern');
  await until(`${q('.mcset-state')}?.textContent === 'Running'`, '26.3 running', 10000);
  await tell(t, modern, 'join Steve');
  await until(`${row('Steve')}?.querySelector('.mc-dot')?.classList.contains('on')`, 'a join behind the prefix', 10000);
  check(true, '26.3: a join behind System chat puts the player online');
  await tell(t, modern, 'ghost Alex');
  await choose('Steve');
  await section('overview');
  await until(`${q('[data-fact="health"] .mcpl-fact-value')}?.textContent === '7'`, 'live detail on 26.3', 10000);
  await tell(t, modern, 'move Steve 200 80 -300');
  await until(`${q('[data-fact="pos"] .mcpl-fact-value')}?.textContent === '200.0, 80.0, -300.0'`, 'the position on 26.3', 10000);
  check(true, '26.3: data get answers reach the overview, and polled positions follow');
  await section('inventory');
  await until(`${q('.mcpl-tile[data-slot="3"]')}?.dataset.id === 'minecraft:bow' && /Live from the server/.test(${q('.mcpl-inv-note')}?.textContent)`, 'the live inventory on 26.3', 10000);
  check(await js(`${qa('.mcpl-tile.editable')}.length`) === 68, '26.3: the inventory is live and its slots can be edited');
  await tell(t, modern, 'told Steve was slain by Zombie');
  await tell(t, modern, 'told Zombie showed Steve that not just the floor is lava');
  await tell(t, modern, 'told Steve has made the advancement [Stone Age]');
  await tell(t, modern, 'emit <Steve> hello from chat');
  await tell(t, modern, 'emit <Steve> System chat: Steve left the game');
  await section('timeline');
  await until(`${qa('.mcpl-event')}.length >= 6`, 'the timeline on 26.3', 10000);
  const modernEvents = await js(`${qa('.mcpl-event')}.map((e) => [e.dataset.type, e.querySelector('.mcpl-event-text').textContent])`);
  check(S(modernEvents.map((e) => e[0])) === S(['chat', 'chat', 'advancement', 'death', 'death', 'join']), `26.3: deaths, the killer-first death and an advancement are events, and chat stays chat (${S(modernEvents)})`);
  check(modernEvents[3][1] === 'Zombie showed Steve that not just the floor is lava' && !modernEvents.slice(2).some((e) => /System chat/.test(e[1])) && modernEvents[0][1] === 'System chat: Steve left the game', '26.3: the timeline has the message and not the prefix, and a player who types the prefix only chats');
  check(await js(`${row('Steve')}.querySelector('.mc-dot').classList.contains('on')`), '26.3: typing the prefix changes nobody\'s state');
  await section('actions');
  await setValue('.mcpl-give-item', 'minecraft:diamond_sword');
  await setValue('.mcpl-give-count', '2');
  await press('.mcpl-give .mcpl-enchant-add');
  await setValue('.mcpl-give .mcpl-enchant-id', 'minecraft:sharpness');
  await setValue('.mcpl-give .mcpl-enchant-level', '5');
  const modernGave = await resultOf(() => press('.mcpl-give-go'));
  check(await reached('modern', 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}] 2'), '26.3: give in the form of 26.3 reaches the server');
  check(await js(`${q('.mcpl-result')}.classList.contains('ok')`) && modernGave.includes('Gave 2 [Diamond Sword] to Steve') && !/System chat/.test(modernGave), `26.3: the answer is found behind the prefix and shown without it (${modernGave})`);
  await press('.mcpl-give .mcpl-enchant-remove');
  await setValue('.mcpl-give-item', 'minecraft:nope');
  const modernNope = await resultOf(() => press('.mcpl-give-go'));
  check(await js(`${q('.mcpl-result')}.classList.contains('bad')`) && /The server refused this/.test(modernNope) && /Unknown item/.test(modernNope) && !/System chat/.test(modernNope), `26.3: a refused give shows as refused (${modernNope})`);
  await resultOf(async () => { await press('.mcpl-op'); await answer('Make Operator'); });
  const modernOp = await resultOf(async () => { await press('.mcpl-op'); await answer('Make Operator'); });
  check(await js(`${q('.mcpl-result')}.classList.contains('bad')`) && /The server refused this/.test(modernOp) && /Nothing changed/.test(modernOp) && !/System chat/.test(modernOp), `26.3: an operator twice is refused in 26.3's wording (${modernOp})`);
  await until(`${row('Alex')}?.querySelector('.mc-dot')?.classList.contains('on')`, 'the list reconcile behind the prefix', 75000);
  check(true, '26.3: list is read behind the prefix: a player no join line told of is found by the 60 s reconcile');
  const modernConsole = await consoleOf(t, modern);
  check(/System chat: Steve joined the game/.test(modernConsole) && /System chat: Steve was slain by Zombie/.test(modernConsole) && /: <Steve> hello from chat/.test(modernConsole), '26.3: the stand-in does log broadcasts behind the prefix, and chat without it');
  check(/Done \(0\.4s\)/.test(modernConsole) && !/has the following entity data/.test(modernConsole) && !/There are \d+ of a max/.test(modernConsole), '26.3: the console does not show the app\'s queries');
  await press('.mcpl-open-log');
  await until(`${qa('.mcpl-log-row')}.length >= 4`, 'the admin log on 26.3', 8000);
  const modernLog = await js(`${qa('.mcpl-log-row')}.map((r) => r.textContent)`);
  check(modernLog.some((l) => /Failed/.test(l) && /The server refused this/.test(l) && /Nothing changed/.test(l)) && !modernLog.some((l) => /System chat/.test(l)), `26.3: the admin log has the reason and the answer, without the prefix (${modernLog.length} rows)`);
  await shot('modern-log.png');
  await choose('Steve');
  await tell(t, modern, 'leave Steve');
  await until(`!${row('Steve')}?.querySelector('.mc-dot').classList.contains('on')`, 'a leave behind the prefix', 8000);
  check(true, '26.3: a leave behind System chat takes the player off');
  await js(`(ide.proc.input(${modern}, 'stop\\n'), true)`);
  await until(`${q('.mcset-state')}?.textContent === 'Stopped'`, '26.3 stopped', 8000);
  await js(`(ide.closeTab(ide.minecraft.players.tabId(${S(dirOf(await js('ide.root'), 'modern'))}), true), true)`);
  check(await js(`window.__exited.length`) === 6, 'every stand-in ended');

  // ---------- 900 px, and narrower ----------
  const overflows = () => js(`(() => {
    const host = ${tabOf};
    const wide = [...host.querySelectorAll('.mcpl-body, .mcpl-scroll, .mcpl-main, .mcpl-rows, .mcpl-result')].filter((n) => n.offsetParent && n.scrollWidth > n.clientWidth + 1).map((n) => n.className);
    const box = host.getBoundingClientRect();
    // The section strip scrolls sideways by itself when a tab is too narrow for it.
    const out = [...host.querySelectorAll('button, input, select')].filter((n) => n.offsetParent && !n.closest('.mcpl-tabs')).filter((n) => { const r = n.getBoundingClientRect(); return r.width && (r.right > box.right + 1 || r.left < box.left - 1); }).map((n) => n.className);
    const cut = [...host.querySelectorAll('.mcpl-card button, .mcpl-quick button, .mcpl-tab')].filter((n) => n.offsetParent && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent);
    return { width: Math.round(box.width), wide, out, cut };
  })()`);
  await openCard('vanilla');
  await until(`${qa('.mcpl-row:not(.hidden)')}.length === 3`, 'the roster again', 10000);
  await choose('Steve');
  for (const [width, label] of [[900, '900 px'], [640, '640 px']]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 0, mobile: false });
    await js(`new Promise((r) => requestAnimationFrame(r))`);
    await t.sleep(300);
    for (const id of ['overview', 'inventory', 'timeline', 'actions']) {
      await section(id);
      await t.sleep(150);
      const o = await overflows();
      check(!o.wide.length && !o.out.length && !o.cut.length, `${label}: ${id} fits (${S(o)})`);
      if (id === 'inventory' || id === 'actions') await shot(`${width}-${id}.png`);
    }
    // Fitting is not being seen: with the Run panel open the player must still come into view, past the list and the result.
    const seen = (sel) => js(`(() => { const n = ${q(sel)}; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`);
    await section('inventory');
    await until(`!!${q('.mcpl-tile[data-slot="0"]')}`, 'the inventory', 5000);
    const tile = await seen('.mcpl-tile[data-slot="0"]');
    await section('actions');
    check(tile && await seen('.mcpl-give-go') && await seen('.mcpl-tab[data-section="timeline"]'), `${label}: the player can be scrolled into view (tile ${tile})`);
    await js(`(${q('.mcpl-tile[data-slot="0"]')}?.scrollIntoView(), ${q('.mcpl-result-close')}?.click(), true)`);
    await section('inventory');
    await shot(`${width}-scrolled.png`);
  }
  const stacked = await js(`({ side: Math.round(${q('.mcpl-side')}.getBoundingClientRect().width), host: Math.round(${tabOf}.getBoundingClientRect().width) })`);
  check(stacked.host <= 640 && stacked.side >= stacked.host - 16, `a narrow tab puts the list above the player, its width less the scrollbar (${S(stacked)})`);
  await section('overview');
  const fold = await js(`({ rows: !!${q('.mcpl-rows')}.offsetParent, find: !!${q('.mcpl-find')}.offsetParent, name: ${q('.mcpl-fold-name')}.textContent, side: Math.round(${q('.mcpl-side')}.getBoundingClientRect().height),
    pages: ${qa('.mcpl-pages button')}.map((b) => Math.round(b.getBoundingClientRect().top)) })`);
  check(!fold.rows && !fold.find && fold.name === 'Steve' && fold.side < 110 && fold.pages[0] === fold.pages[1], `once a player is chosen the list folds into a row, with Search and Admin Log on one row (${S(fold)})`);
  const scroller = `${tabOf}.querySelector('.mcpl-body')`;
  const wheelOver = async (sel) => {
    await js(`(${scroller}.scrollTop = 0, true)`);
    const spot = await js(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: 200 });
    await t.sleep(300);
    return js(`${scroller}.scrollTop`);
  };
  check(await wheelOver('.mcpl-fold') > 0, 'the wheel over the folded list moves the page');
  await js(`(${scroller}.scrollTop = 0, true)`);
  await press('.mcpl-fold');
  await until(`!!${row('Alex')}?.offsetParent`, 'the list open again', 3000);
  const opened = await js(`({ height: Math.round(${q('.mcpl-rows')}.getBoundingClientRect().height), inner: ${q('.mcpl-rows')}.scrollHeight - ${q('.mcpl-rows')}.clientHeight, fold: Math.round(${q('.mcpl-fold')}.getBoundingClientRect().height), pages: Math.round(${q('.mcpl-pages')}.getBoundingClientRect().height) })`);
  check(opened.inner <= 0 && opened.height === 3 * 46 && opened.fold < 50 && opened.pages < 50, `the list opens as tall as its rows, with nothing of its own to scroll, and its row and the page buttons stay one row high (${S(opened)})`);
  check(await wheelOver('.mcpl-rows') > 0, 'the wheel over the open list moves the page');
  await js(`(${scroller}.scrollTop = 0, true)`);
  await mouse(row('Steve'));
  check(await folded(), 'choosing a player from the open list folds it again');
  await cdp('Emulation.clearDeviceMetricsOverride');
  await section('overview');
  await js(`(ide.closeTab(ide.minecraft.players.tabId(${S(dirOf(await js('ide.root'), 'vanilla'))}), true), true)`);
  await until(`!${tabOf}`, 'the tab closed', 5000);
} catch (err) {
  check(false, `stopped early: ${err.message}`);
  await shot('failure.png').catch(() => {});
}

// ---------- what a person sees, at three widths ----------
// One tour per mode, in Korean, with the screenshots a reviewer reads: wide, then 1024 and 900 px windows. Every step is a
// real press, so a control that a sticky bar or a stacked list hides stops the tour with its name.
async function gallery(ctx, h, tag) {
  const { cdp, sleep, shot, js, until } = ctx;
  for (const [label, width] of [['wide', 0], ['1024', 1024], ['900', 900]]) {
    if (width) await cdp('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 0, mobile: false });
    await sleep(400);
    const name = (what) => `${tag}-${label}-${what}.png`;
    await h.section('overview');
    await shot(name('overview'));
    const box = await js(`(() => { const r = ${tabOf}.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), stacked: !!${h.q('.mcpl-fold')}.offsetParent }; })()`);
    check(box.w > 0, `${tag} ${label}: the tab is ${S(box)}`);
    await h.section('inventory');
    await until(`!!${h.q('.mcpl-tile[data-slot="0"]')}`, 'the inventory', 8000);
    await h.hover(h.q('.mcpl-tile[data-slot="0"]'));
    await until(`!!document.querySelector('.mcpl-tip')`, 'a tooltip', 5000);
    await shot(name('inventory'));
    await h.away();
    await h.section('actions');
    await h.setValue('.mcpl-give-item', '');
    await h.press('.mcpl-give-item');
    await until(`${pickRows}.length === 5`, 'the item list', 8000);
    await shot(name('give-list'));
    await h.mouse(pickRow('minecraft:diamond_sword'));
    await shot(name('give-picked'));
    await h.resultOf(() => h.press('.mcpl-give-go'));
    await shot(name('result'));
    await h.press('.mcpl-result-more > summary');
    await shot(name('result-details'));
    await h.section('timeline');
    await shot(name('timeline'));
    await h.press('.mcpl-open-search');
    await sleep(400);
    await shot(name('search'));
    await h.press('.mcpl-open-log');
    await sleep(400);
    await shot(name('log'));
    if (await h.folded()) {
      await h.press('.mcpl-fold');
      await shot(name('list-open'));
    }
    await h.choose('Steve');
  }
  await cdp('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
}
// Every text the tab wrote itself: names, chat and server answers are a stranger's text, marked as such. An id is not
// English, and the tooltip and the list are on the body.
const english = (ctx) => ctx.js(`(() => {
  const found = [];
  const walk = (n) => {
    if (n.nodeType === 3) { if (/[A-Za-z]{2,}/.test(n.textContent.replace(/[a-z0-9_.-]+:[a-z0-9_./-]+/g, '').replace(/Minecraft|Paper|Vanilla|Steve|Alex|Griefer|OP|ID|[IVX]+$/g, ''))) found.push(n.textContent); return; }
    if (n.nodeType !== 1 || n.hasAttribute('data-user-text') || !n.getClientRects().length) return;
    for (const c of n.childNodes) walk(c);
  };
  for (const root of [${tabOf}, document.querySelector('.mcpl-tip'), document.querySelector('.mcpl-picks')]) if (root) walk(root);
  for (const n of ${tabOf}.querySelectorAll('input')) if (n.offsetParent && /[A-Za-z]{3,}/.test(n.placeholder)) found.push(n.placeholder);
  return found;
})()`);

// ---------- Korean ----------
{
  const k = await launch({ name: 'minecraft-players', port: 9933, lang: 'ko-KR', mode: 'craft', projectDir: project, env });
  k.korean = true;
  const h = helpers(k);
  try {
    await k.until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
    await k.js(`ide.minecraft.refresh()`);
    await h.toCards();
    if (!samePath(await k.js('ide.root'), project)) throw new Error('the Korean window is not on the test project');
    await stubRun(k);
    await h.openCard('vanilla');
    await k.until(`${h.qa('.mcpl-row:not(.hidden)')}.length === 3`, 'the roster in Korean', 10000);
    await h.choose('Steve');
    await k.until(`/오프라인/.test(${h.q('.mcpl-flags')}?.textContent)`, 'Korean flags', 5000);
    await k.shot('ko-stopped.png');
    const pages = [['overview', () => h.section('overview')], ['inventory', () => h.section('inventory')], ['timeline', () => h.section('timeline')], ['actions', () => h.section('actions')],
      ['search', () => h.press('.mcpl-open-search')], ['log', () => h.press('.mcpl-open-log')]];
    for (const [id, open] of pages) {
      await open();
      await k.sleep(500);
      const words = await english(k);
      check(!words.length, `Korean: ${id} shows no English of its own (${S(words)})`);
      await k.shot(`ko-${id}.png`);
    }
    const missing = await k.js(`[...i18n.missing]`);
    check(!missing.filter((s) => /player|server|inventory/i.test(s)).length, `Korean: nothing asked for was missing (${S(missing.slice(0, 5))})`);
    await h.choose('Steve');
    await h.section('inventory');
    await k.until(`!!${h.q('.mcpl-tile[data-slot="0"] img')}`, 'icon in Korean', 8000);
    await k.sleep(300);
    await h.hover(h.q('.mcpl-tile[data-slot="0"]'));
    await k.until(`!!document.querySelector('.mcpl-tip')`, 'tooltip in Korean', 5000);
    const tip = await k.js(`document.querySelector('.mcpl-tip').textContent`);
    const tipWords = await english(k);
    check(/다이아몬드 검/.test(tip) && /날카로움 V/.test(tip) && /내구도 1554 \/ 1561/.test(tip) && !tipWords.length, `Korean: a tooltip has Korean names, a roman level and no English of its own (${tip}, ${S(tipWords)})`);
    await h.away();
    const id = await start(k, 'vanilla');
    await tell(k, id, 'join Steve');
    await k.until(`/접속 중/.test(${h.q('.mcpl-flags')}?.textContent)`, 'online in Korean', 10000);
    await h.section('actions');
    await h.press('.mcpl-clear-all');
    await k.until(`/인벤토리를 전부 비울까요/.test(${lastDialog}?.textContent)`, 'confirmation in Korean', 5000);
    check(/'Steve' 플레이어/.test(await k.js(`${lastDialog}.textContent`)), 'Korean: a confirmation keeps particles off the name');
    await h.answer('취소');
    const said = await h.resultOf(async () => { await h.setValue('.mcpl-give-item', 'BAD ID!'); await h.press('.mcpl-give-go'); });
    check(/아이템 ID가 아니에요/.test(said), `Korean: a refusal is in Korean (${said})`);
    await h.setValue('.mcpl-give-item', '');
    await h.press('.mcpl-give-item');
    await k.type('다이아');
    await k.until(`${pickRows}.length === 2`, 'a Korean item search', 8000);
    check(await k.js(`${pickRows}.map((p) => p.querySelector('.mcpl-pick-name').textContent).join()`) === '다이아몬드 검,다이아몬드', 'Korean: items are found and listed by Korean name');
    await h.mouse(pickRow('minecraft:diamond_sword'));
    check(await k.js(`${h.q('.mcpl-give .mcpl-chosen-name')}.textContent`) === '다이아몬드 검', 'Korean: a pick shows its Korean name in the box');
    await h.setValue('.mcpl-give-count', '2');
    await h.press('.mcpl-give .mcpl-enchant-add');
    await h.press('.mcpl-give .mcpl-enchant-id');
    await k.until(`${pickRows}.length === 3`, 'the enchantments in Korean', 5000);
    await k.type('날카');
    await k.until(`${pickRows}.length === 1`, 'a Korean enchantment search', 5000);
    await k.shot('ko-enchant-search.png');
    const found = await k.js(`${pickRows}.map((p) => p.dataset.id)`);
    check(S(found) === S(['minecraft:sharpness']), `Korean: an enchantment is found by its Korean name and stores its id (${S(found)})`);
    await h.mouse(pickRow('minecraft:sharpness'));
    const gift = await h.resultOf(() => h.press('.mcpl-give-go'));
    check(await reached('vanilla', 'give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":1}}] 2') && gift.includes("'Steve' 플레이어에게 다이아몬드 검 2개를 줬어요."), `Korean: the result says what happened (${gift})`);
    const barWords = await english(k);
    check(!barWords.length, `Korean: the result bar has no English of its own (${S(barWords)})`);
    await h.press('.mcpl-effect-id');
    await k.until(`${pickRows}.length === 3`, 'the effects in Korean', 5000);
    await k.type('신속');
    await k.until(`${pickRows}.length === 1`, 'a Korean effect search', 5000);
    const effects = await k.js(`${pickRows}.map((p) => p.dataset.id)`);
    check(S(effects) === S(['minecraft:speed']), `Korean: an effect is found by its Korean name and stores its id (${S(effects)})`);
    await k.press('Enter');
    const effected = await h.resultOf(() => h.press('.mcpl-effect-go'));
    check(await reached('vanilla', 'effect give Steve minecraft:speed 30 0 false') && effected.includes("'Steve' 플레이어에게 신속 효과를 줬어요."), `Korean: an effect's result names it (${effected})`);
    await tell(k, id, 'emit <Steve> 안녕하세요');
    await k.until(`!!${h.q('.mcpl-q-heal')}`, 'the player', 5000);
    await lostClicks(k, h, 'ko-code', 'Steve', 'vanilla');
    await gallery(k, h, 'code');
    await k.js(`(ide.proc.input(${id}, 'stop\\n'), true)`);
    await k.until(`${h.q('.mcset-state')}?.textContent === '중지됨'`, 'stopped in Korean', 8000);
  } catch (err) {
    check(false, `Korean run stopped early: ${err.message}`);
    await k.shot('failure-ko.png').catch(() => {});
  }
  t.consoleErrors.push(...k.consoleErrors);
  t.cspViolations.push(...k.cspViolations);
  k.close();
}

// ---------- Craft ----------
{
  const c = await launch({ name: 'minecraft-players', port: 9934, lang: 'ko', mode: 'craft', projectDir: project, env });
  c.korean = true;
  const h = helpers(c);
  try {
    await c.until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
    if (!samePath(await c.js('ide.root'), project)) throw new Error('the craft window is not on the test project');
    await stubRun(c);
    await h.mouse(`document.querySelector('.mcs-page[data-page="servers"]')`);
    await h.openCard('vanilla');
    await c.until(`document.body.classList.contains('mc-craft-tab') && getComputedStyle(document.getElementById('editorArea')).display !== 'none' && getComputedStyle(document.getElementById('craftHost')).display === 'none' && !!${tabOf}?.offsetParent`, 'the tab over the app', 10000);
    check(true, 'Craft: Players on a server card opens the tab over the app');
    await c.until(`${h.qa('.mcpl-row:not(.hidden)')}.length === 3`, 'the roster in Craft', 10000);
    await h.press('.mcpl-start');
    await c.until(`window.__started.length === 1 && window.__started[0].dir === 'servers/vanilla'`, 'Start in Craft', 3000);
    check(true, 'Craft: the tab has its own Start, so the owner need not close it to reach the card');
    await c.shot('craft-stopped.png');
    await c.until(`!${h.q('.mcpl-start')}.disabled`, 'Start back', 3000);
    const id = await start(c, 'vanilla');
    await c.until(`${h.q('.mcset-state')}?.textContent === '실행 중'`, 'running in Craft', 10000);
    await tell(c, id, 'join Steve');
    await h.choose('Steve');
    await c.until(`/접속 중/.test(${h.q('.mcpl-flags')}?.textContent)`, 'online in Craft', 10000);
    await h.section('inventory');
    await c.until(`/서버의 현재 상태/.test(${h.q('.mcpl-inv-note')}?.textContent)`, 'live in Craft', 10000);
    await c.shot('craft-inventory.png');
    await h.section('actions');
    await h.setValue('.mcpl-give-item', 'minecraft:stone');
    await c.sleep(400);
    const before = sentBy('vanilla').length;
    const said = await h.resultOf(() => h.press('.mcpl-give-go'));
    check(await reached('vanilla', 'give Steve minecraft:stone 1') && sentBy('vanilla').length === before + 1 && /'Steve' 플레이어에게 돌 1개를 줬어요/.test(said), `Craft: give reaches the server (${said})`);
    await lostClicks(c, h, 'craft', 'Steve', 'vanilla');
    await gallery(c, h, 'craft');
    await c.cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 0, mobile: false });
    await c.sleep(300);
    const fit = await c.js(`[...${tabOf}.querySelectorAll('.mcpl-scroll, .mcpl-main')].filter((n) => n.offsetParent && n.scrollWidth > n.clientWidth + 1).map((n) => n.className)`);
    check(!fit.length, `Craft: 900 px fits (${S(fit)})`);
    await c.cdp('Emulation.clearDeviceMetricsOverride');
    await c.js(`(ide.proc.input(${id}, 'stop\\n'), true)`);
    await c.until(`${h.q('.mcset-state')}?.textContent === '중지됨'`, 'stopped in Craft', 8000);
    await c.js(`(ide.closeTab(ide.activeTab().path, true), true)`);
    await c.until(`!document.body.classList.contains('mc-craft-tab') && getComputedStyle(document.getElementById('craftHost')).display !== 'none'`, 'the app back', 10000);
    check(true, 'Craft: closing the tab brings the app back');
  } catch (err) {
    check(false, `Craft run stopped early: ${err.message}`);
    await c.shot('failure-craft.png').catch(() => {});
  }
  t.consoleErrors.push(...c.consoleErrors);
  t.cspViolations.push(...c.cspViolations);
  c.close();
}

// ---------- dragging items, and detailed logging ----------
{
  const c = await launch({ name: 'minecraft-players', port: 9935, lang: 'ko', mode: 'craft', projectDir: project, env });
  c.korean = true;
  const h = helpers(c);
  const { js, until, shot, sleep } = c;
  const { q, qa, dragTo, resultOf, section, choose, press, answer, setValue, mouse, textOf } = h;
  const tile = (n, ender) => q(`.mcpl-tile[data-key="${ender ? 200 + n : n}"]`);
  const filled = (n) => js(`${tile(n)}.classList.contains('filled')`);
  const idAt = (n) => js(`${tile(n)}.dataset.id`);
  const replaced = () => logOf('drag').filter((l) => l.includes('item replace')).length;
  const stateClean = () => js(`!document.querySelector('.mcpl-ghost') && !document.body.classList.contains('mcpl-dragging') && !document.querySelector('.mcpl-tile.dragging, .mcpl-tile.drop')`);
  const game = async (id) => {
    await tell(c, id, 'stacks');
    await sleep(120);
    return JSON.parse(readFileSync(path.join(serverDir('drag'), 'stacks.json'), 'utf8'));
  };
  const detailed = (name) => path.join(serverDir(name), 'plugins', 'NanoBridge.jar');
  const today = new Date().toISOString().slice(0, 10);
  const bridgeFile = path.join(serverDir('drag'), '.nano', 'bridge', `${today}.jsonl`);
  try {
    await c.until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
    if (!samePath(await c.js('ide.root'), project)) throw new Error('the craft window is not on the test project');
    await stubRun(c);
    await mouse(`document.querySelector('.mcs-page[data-page="servers"]')`);
    await h.openCard('drag');
    const id = await start(c, 'drag');
    await until(`${q('.mcset-state')}?.textContent === '실행 중'`, 'the drag server running', 10000);
    await tell(c, id, 'join Steve');
    await choose('Steve');
    await until(`/접속 중/.test(${q('.mcpl-flags')}?.textContent)`, 'Steve online', 10000);
    await section('inventory');
    await until(`${tile(0)}?.classList.contains('editable')`, 'a live inventory', 10000);
    check(await js(`${tile(0, true).replace(/\.querySelector\(.*$/, '')}.querySelector('.mcpl-tile[data-ender].editable') !== null`), 'the ender chest takes part, its form being confirmed');
    check(await js(`${q('.mcpl-trash')}.offsetParent !== null`), 'the trash shows on a live inventory');

    const before = replaced();
    const during = await dragTo(tile(0), tile(5), { during: async () => js(`({ ghost: !!document.querySelector('.mcpl-ghost'), source: ${tile(0)}.classList.contains('dragging'), target: ${tile(5)}.classList.contains('drop'), ghostOnTop: getComputedStyle(document.querySelector('.mcpl-ghost')).pointerEvents === 'none' })`) });
    check(during.ghost && during.source && during.target && during.ghostOnTop, `a real drag shows the ghost, the source and the target: ${S(during)}`);
    await until(`!${tile(0)}.classList.contains('filled') && ${tile(5)}.dataset.id === 'minecraft:diamond_sword'`, 'the moved slots repainted', 8000);
    check(await stateClean(), 'nothing of the drag is left');
    check(!(await js(`!!document.querySelector('.dialog')`)), 'the release does not open a slot dialog');
    check(replaced() === before + 3, `a move is three steps: ${replaced() - before}`);
    const sent = logOf('drag');
    check(sent.at(-2)?.startsWith('execute if data entity Steve') && sent.at(-2).includes('hotbar.0 with minecraft:air') || sent.some((l) => l.includes('hotbar.0 with minecraft:air')), 'the clear is guarded');
    const stacks = await game(id);
    check(stacks[5]?.extra?.includes('minecraft:damage') && !stacks[0], `the game moved the stack with its data: ${S(stacks[5])}`);
    await shot('drag-moved.png');

    const swapped = await resultOf(() => dragTo(tile(1), tile(9)));
    await until(`${tile(1)}.dataset.id === 'minecraft:stone' && ${tile(9)}.dataset.id === 'minecraft:dirt'`, 'the swapped slots repainted', 8000);
    check(/맞바꿨어요/.test(swapped), `a filled slot swaps: ${swapped}`);
    const afterSwap = await game(id);
    check(afterSwap[1]?.id === 'minecraft:stone' && afterSwap[1].count === 64 && afterSwap[9]?.count === 32 && !afterSwap[35], 'and the temporary slot is empty again');

    const count = replaced();
    await dragTo(tile(2), tile(6), { keepHolding: true });
    await js(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
    await sleep(60);
    await h.up(await h.spotOf(tile(6), true));
    await sleep(200);
    check(await stateClean() && replaced() === count && await filled(2), 'Escape ends a drag and sends nothing');
    check(!(await js(`!!document.querySelector('.dialog')`)), 'and the release after it opens nothing');

    await dragTo(tile(2), q('.mcset-title'));
    await sleep(200);
    check(await stateClean() && replaced() === count && await filled(2), 'a drop outside any slot sends nothing');

    const held = await dragTo(tile(2), tile(7), {
      during: async () => {
        await tell(c, id, 'click 2 3');
        await sleep(100);
        const node = `${tile(2)}`;
        await js(`(window.__tile = ${node}, ${q('.mcpl-reload')}.click(), true)`);
        await sleep(400);
        return js(`({ same: window.__tile === ${node}, dragging: window.__tile.classList.contains('dragging') })`);
      },
    });
    check(held.same && held.dragging, `a refresh during a drag does not pull the tile away: ${S(held)}`);
    await until(`/바뀌어서 보내지 않았어요/.test(${q('.mcpl-result')}?.textContent)`, 'the change noticed', 8000);
    check(replaced() === count, 'what changed in the game stops the move before any line is sent');
    await until(`${tile(3)}.dataset.id === 'minecraft:diamond' && !${tile(2)}.classList.contains('filled')`, 'the held detail shown after the drag', 8000);
    check(await stateClean(), 'and the tab shows the game again');
    await tell(c, id, 'click 2 3');
    await press('.mcpl-reload');
    await until(`${tile(2)}.dataset.id === 'minecraft:diamond'`, 'back in place', 8000);

    const toEnder = await resultOf(() => dragTo(tile(2), tile(1, true)));
    await until(`${tile(1, true)}.dataset.id === 'minecraft:diamond'`, 'into the ender chest', 8000);
    check(/옮겼어요/.test(toEnder) && logOf('drag').some((l) => l.includes('enderchest.1 from entity Steve hotbar.2')), `a stack into the ender chest: ${toEnder}`);

    await dragTo(tile(10), q('.mcpl-trash'), { during: async () => check(await js(`${q('.mcpl-trash')}.classList.contains('drop')`), 'the trash lights up') });
    await until(`[...document.querySelectorAll('.dialog')].length > 0`, 'the trash asks first', 5000);
    const tossCount = replaced();
    await answer('취소');
    await sleep(150);
    check(replaced() === tossCount && await filled(10), 'and saying no keeps the stack');
    await dragTo(tile(10), q('.mcpl-trash'));
    await answer('버리기');
    await until(`!${tile(10)}.classList.contains('filled')`, 'thrown away', 8000);
    check(replaced() === tossCount + 1, 'one line clears it');

    await setValue('.mcpl-palette-find', 'stone');
    await until(`${qa('.mcpl-palette-row')}.length > 0`, 'the item list', 8000);
    await setValue('.mcpl-palette-count', '12');
    const row = q('.mcpl-palette-row[data-id="minecraft:stone"]');
    const placed = await resultOf(() => dragTo(row, tile(11)));
    await until(`${tile(11)}.dataset.id === 'minecraft:stone'`, 'placed', 8000);
    check(logOf('drag').some((l) => l.includes('hotbar') === false && l.endsWith('inventory.2 with minecraft:stone 12')) && /돌 12개/.test(placed), `the list's item lands with the list's count: ${placed}`);
    const trashFromList = replaced();
    await dragTo(row, q('.mcpl-trash'));
    await sleep(150);
    check(replaced() === trashFromList && !(await js(`!!document.querySelector('.dialog')`)), 'an item from the list has nothing to throw away');

    await press(`.mcpl-tile[data-key="5"]`);
    await until(`!!document.querySelector('.dialog .mcpl-slot-dest')`, 'a plain press still opens the dialog', 5000);
    await js(`(() => { const s = document.querySelector('.dialog .mcpl-slot-dest'); s.value = '6'; return true; })()`);
    await answer('이동');
    await until(`${tile(6)}.dataset.id === 'minecraft:diamond_sword' && !${tile(5)}.classList.contains('filled')`, 'moved by the dialog', 8000);
    check(true, 'the dialog is the keyboard\'s way to move a stack');

    await tell(c, id, 'lose 12');
    await sleep(100);
    const lost = await resultOf(() => dragTo(tile(9), tile(12)));
    check(/관리 기록에 남겼어요/.test(lost), `a stack lost in a move says where its data went: ${lost}`);
    await press('.mcpl-open-log');
    await until(`!!${q('.mcpl-log-row details')}`, 'the lost stack in the admin log', 8000);
    await press('.mcpl-log-row details summary');
    const kept = await js(`({ open: ${q('.mcpl-log-row details')}.open, text: ${q('.mcpl-log-row details')}.textContent })`);
    check(kept.open && kept.text.includes('{Slot: 9b, id: "minecraft:dirt", count: 32}'), `the admin log shows the stack as the game printed it: ${S(kept)}`);
    await shot('drag-lost-stack.png');
    await choose('Steve');
    await section('inventory');
    await until(`${tile(6)}?.classList.contains('editable')`, 'the inventory again', 8000);

    const spot = await dragTo(tile(6), tile(8), { keepHolding: true, during: async (to) => { await tell(c, id, 'leave Steve'); await until(`/접속 안 함|오프라인/.test(${q('.mcpl-flags')}?.textContent)`, 'Steve gone', 8000); return to; } });
    await h.up(spot);
    await sleep(200);
    check(await stateClean(), 'a player who leaves ends the drag');
    await until(`${qa('.mcpl-tile.editable')}.length === 0`, 'read only when offline', 8000);
    check(/보기만 할 수 있어요/.test(await textOf('.mcpl-inv-note')) && await js(`${q('.mcpl-inv-tools')}.classList.contains('hidden')`), `offline stays read only, and says so: ${await textOf('.mcpl-inv-note')}`);
    await shot('drag-offline.png');
    await tell(c, id, 'join Steve');

    check(/꺼짐/.test(await textOf('.mcpl-bridge')), `detailed logging starts off: ${await textOf('.mcpl-bridge')}`);
    check(!existsSync(detailed('drag')), 'and no plugin is there');
    await press('.mcpl-bridge');
    await until(`!!document.querySelector('.dialog .mcpl-bridge-offer')`, 'the offer', 5000);
    const offer = await js(`document.querySelector('.dialog .mcpl-bridge-offer').textContent`);
    check(/plugins\//.test(offer) && /채팅은 읽지 않아요/.test(offer) && /다시 시작/.test(offer) && /플레이어에게 알려 주세요/.test(offer), `the offer says what it does: ${offer}`);
    check(!(await js(`document.querySelector('.dialog .mcpl-bridge-new').checked`)), 'the default for new servers is off');
    await shot('bridge-offer.png');
    await answer('취소');
    await sleep(100);
    check(!existsSync(detailed('drag')), 'closing the offer installs nothing');
    await press('.mcpl-bridge');
    await until(`!!document.querySelector('.dialog .mcpl-bridge-offer')`, 'the offer again', 5000);
    await mouse(`document.querySelector('.dialog .mcpl-bridge-new')`);
    await sleep(800);
    check(await js(`ide.settings.get('minecraft.detailedLogNewServers', false) === true`), 'the checkbox is the app-wide default');
    await answer('플러그인 설치');
    await until(`/재시작 필요/.test(${q('.mcpl-bridge')}?.textContent)`, 'a restart needed', 8000);
    check(existsSync(detailed('drag')), 'install puts the jar in plugins/');

    await press('.mcpl-bridge');
    await until(`!!document.querySelector('.dialog .mcpl-bridge-offer')`, 'the offer for an installed plugin', 5000);
    await answer('내 다른 서버에도 적용…');
    await until(`[...document.querySelectorAll('.dialog')].length > 1`, 'the one confirmation', 5000);
    const asked = await js(`${lastDialog}.textContent`);
    check(/papertwo/.test(asked) && /알려 주세요/.test(asked) && !/vanilla/.test(asked.split('?')[0]) && !/paperold/.test(asked.split('?')[0]), `one confirmation names the servers and repeats the sentence: ${asked}`);
    await answer('모두 설치');
    await until(`!!document.querySelector('.mcpl-bridge-report')`, 'the report', 8000);
    const line = (name) => js(`document.querySelector('.mcpl-bridge-line[data-server="${name}"] .mcpl-bridge-says')?.textContent ?? ''`);
    check(/설치했어요/.test(await line('papertwo')) && existsSync(detailed('papertwo')), `done on the other Paper kind: ${await line('papertwo')}`);
    check(/Vanilla/.test(await line('vanilla')) && !existsSync(detailed('vanilla')), `Vanilla keeps its reason: ${await line('vanilla')}`);
    check(/Fabric/.test(await line('fabric')) && !existsSync(detailed('fabric')), `Fabric keeps its reason: ${await line('fabric')}`);
    check(/1\.20/.test(await line('paperold')) && !existsSync(detailed('paperold')), `an old Paper says why: ${await line('paperold')}`);
    await shot('bridge-report.png');
    await answer('닫기');
    await sleep(100);
    await answer('취소');

    const uuid = STEVE;
    const rec = (o) => S({ v: 1, time: new Date().toISOString(), uuid, type: 'break', world: 'world', x: 10, y: 64, z: -5, n: 1, id: 'minecraft:stone', ...o });
    write(bridgeFile, `${S({ v: 1, type: 'hello', plugin: '1.0.0' })}\n${rec({ n: 12, at: [[10, 64, -5], [11, 64, -5]] })}\n${rec({ type: 'hit', other: 'minecraft:zombie', weapon: 'minecraft:diamond_sword', amount: 11.5, id: undefined, n: 3 })}\n${rec({ type: 'take', id: 'minecraft:diamond', other: 'minecraft:chest', n: 4, x: 1, y: 2, z: 3 })}\n${rec({ type: 'pickup', id: 'minecraft:dirt', n: 5, x: 2 })}\n{"forged":`);
    await until(`/켜짐/.test(${q('.mcpl-bridge')}?.textContent)`, 'the plugin\'s hello turns it on', 8000);
    await section('timeline');
    await until(`${qa('.mcpl-event[data-type="break"]')}.length === 1`, 'the record in the timeline', 8000);
    await until(`/돌 12개를 캤어요/.test(${q('.mcpl-event[data-type="break"]')}.textContent)`, 'its Korean name from the item catalog', 8000);
    const chips = await js(`${qa('.mcpl-timeline .mcpl-chip')}.map((c) => c.textContent)`);
    check(['블록', '상자', '공격', '아이템'].every((w) => chips.includes(w)), `the four chips: ${chips}`);
    await press('.mcpl-timeline .mcpl-chip[data-type="combat"]');
    await until(`${qa('.mcpl-event')}.length === 1 && !!${q('.mcpl-event[data-type="hit"]')}`, 'the combat chip', 8000);
    check(/11\.5/.test(await textOf('.mcpl-event[data-type="hit"]')), 'combat with its amount');
    await press('.mcpl-timeline .mcpl-chip[data-type="combat"]');
    await shot('bridge-timeline.png');
    await press('.mcpl-open-search');
    await setValue('.mcpl-all-search', '11 64 -5');
    await until(`${qa('.mcpl-search .mcpl-event')}.length === 1`, 'who broke this block', 8000);
    check(/Steve/.test(await textOf('.mcpl-search .mcpl-event')), 'a coordinate finds who broke the block');
    await setValue('.mcpl-all-search', '다이아몬드');
    await until(`!!${q('.mcpl-search .mcpl-event[data-type="take"]')}`, 'a block by its Korean name', 8000);
    check(true, 'a Korean name finds the item\'s records');

    await press('.mcpl-bridge');
    await until(`!!document.querySelector('.dialog .mcpl-bridge-offer')`, 'the offer to remove', 5000);
    await answer('플러그인 제거');
    await until(`/꺼짐/.test(${q('.mcpl-bridge')}?.textContent)`, 'removed', 8000);
    check(!existsSync(detailed('drag')), 'remove takes the jar out');
    await js(`(ide.proc.input(${id}, 'stop\\n'), true)`);
    await until(`${q('.mcset-state')}?.textContent === '중지됨'`, 'the drag server stopped', 8000);
    await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
    await until(`getComputedStyle(document.getElementById('craftHost')).display !== 'none'`, 'the app back after the drag tab', 10000);

    await h.openCard('fabric');
    await until(`!!${q('.mcpl-bridge')}`, 'the fabric tab', 5000);
    await until(`/사용 불가/.test(${q('.mcpl-bridge')}.textContent)`, 'not available on Fabric', 5000);
    await press('.mcpl-bridge');
    await until(`!!document.querySelector('.dialog .mcpl-bridge-why')`, 'the reason on Fabric', 5000);
    check(/Fabric, Forge, NeoForge는 지원하지 않아요/.test(await js(`document.querySelector('.dialog .mcpl-bridge-why').textContent`)) && !(await js(`!!(${dialogButton('플러그인 설치')})`)), 'a Fabric server gets a reason and no install button');
    await answer('닫기');
  } catch (err) {
    check(false, `Drag run stopped early: ${err.message}`);
    await shot('failure-drag.png').catch(() => {});
  }
  t.consoleErrors.push(...c.consoleErrors);
  t.cspViolations.push(...c.cspViolations);
  c.close();
}

await pause(500);
const left = processSnapshot().filter((p) => p.cmd.includes(script));
check(!left.length, `no stand-in server is left running (${left.length})`);
t.finish();
