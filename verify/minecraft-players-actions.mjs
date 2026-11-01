// Pure Node (no window, no real server, no real download): main/minecraft/players/actions.js, the console lines of each
// player action per game version, and main/minecraft/players/items.js, the item catalog, against a local stand-in of
// Mojang's version list, client jars, asset index and asset host through PYIDE_MC_SOURCES. The client jars here are
// written from the formats on minecraft.wiki. They are not Mojang's, so what a real jar holds stays unverified.
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import zlib from 'zlib';

const require = createRequire(import.meta.url);
const { build, NAME, CHECKED_THROUGH } = require('../main/minecraft/players/actions.js');
const items = require('../main/minecraft/players/items.js');
const { writeZip } = require('../main/minecraft/zipfile.js');

let passed = 0;
let failed = 0;
const check = (ok, what) => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL: ${what}`); }
};
const same = (got, want, what) => check(got === want, `${what}: got ${JSON.stringify(got)?.slice(0, 300)}, want ${JSON.stringify(want)?.slice(0, 300)}`);
const line = (action, version = '1.21.11', kind = 'paper') => {
  const { commands } = build(action, { version, kind });
  if (commands.length !== 1) throw new Error(`${commands.length} commands`);
  return commands[0];
};
const refusal = (action, version = '1.21.11', kind = 'paper') => {
  try { return { commands: build(action, { version, kind }).commands }; } catch (err) { return err.expected ? err : { unexpected: err }; }
};
const refused = (action, code, what, version, kind) => {
  const r = refusal(action, version, kind);
  check(r.code === code && !r.commands && !r.unexpected, `${what}: wanted refusal ${code}, got ${r.code || JSON.stringify(r.commands) || r.unexpected}`);
};
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const FULL_AT = String.fromCodePoint(0xff20);

// ---- actions: the exact line of every form

const T = { target: 'Steve' };
const FORMS = [
  [{ ...T, type: 'give', item: 'diamond' }, '1.21.11', 'give Steve minecraft:diamond 1'],
  [{ ...T, type: 'give', item: 'minecraft:diamond', count: 64 }, '1.13', 'give Steve minecraft:diamond 64'],
  [{ ...T, type: 'give', item: 'create:wrench', count: 2 }, '1.20.1', 'give Steve create:wrench 2'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }, { id: 'minecraft:unbreaking', level: 3 }] }, '1.13',
    'give Steve minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s},{id:"minecraft:unbreaking",lvl:3s}]} 1'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }] }, '1.20.4', 'give Steve minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]} 1'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }] }, '1.20.5', 'give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5}}] 1'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }] }, '1.21.4', 'give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5}}] 1'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }] }, '1.21.5', 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}] 1'],
  [{ ...T, type: 'give', item: 'diamond_sword', enchantments: [{ id: 'sharpness', level: 5 }, { id: 'mod:zap', level: 2 }] }, '26.3', 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5,"mod:zap":2}] 1'],
  [{ ...T, type: 'give', item: 'enchanted_book', enchantments: [{ id: 'mending', level: 1 }] }, '1.20.1', 'give Steve minecraft:enchanted_book{StoredEnchantments:[{id:"minecraft:mending",lvl:1s}]} 1'],
  [{ ...T, type: 'give', item: 'enchanted_book', enchantments: [{ id: 'mending', level: 1 }] }, '1.21.1', 'give Steve minecraft:enchanted_book[stored_enchantments={levels:{"minecraft:mending":1}}] 1'],
  [{ ...T, type: 'give', item: 'enchanted_book', enchantments: [{ id: 'mending', level: 1 }] }, '1.21.5', 'give Steve minecraft:enchanted_book[stored_enchantments={"minecraft:mending":1}] 1'],
  [{ ...T, type: 'give', item: 'stick', enchantments: [] }, '1.21.5', 'give Steve minecraft:stick 1'],
  [{ ...T, type: 'clear' }, '1.21.11', 'clear Steve'],
  [{ ...T, type: 'clear', item: 'dirt' }, '1.13', 'clear Steve minecraft:dirt'],
  [{ ...T, type: 'clear', item: 'dirt', count: 3 }, '1.21.11', 'clear Steve minecraft:dirt 3'],
  [{ ...T, type: 'replaceSlot', slot: 0, item: 'stone', count: 3 }, '1.17', 'item replace entity Steve hotbar.0 with minecraft:stone 3'],
  [{ ...T, type: 'replaceSlot', slot: 8, item: 'stone' }, '26.3', 'item replace entity Steve hotbar.8 with minecraft:stone 1'],
  [{ ...T, type: 'replaceSlot', slot: 9, item: 'stone' }, '1.21.11', 'item replace entity Steve inventory.0 with minecraft:stone 1'],
  [{ ...T, type: 'replaceSlot', slot: 35, item: 'stone' }, '1.21.11', 'item replace entity Steve inventory.26 with minecraft:stone 1'],
  [{ ...T, type: 'replaceSlot', slot: 100, item: 'iron_boots' }, '1.21.11', 'item replace entity Steve armor.feet with minecraft:iron_boots 1'],
  [{ ...T, type: 'replaceSlot', slot: 101, item: 'iron_leggings' }, '1.21.11', 'item replace entity Steve armor.legs with minecraft:iron_leggings 1'],
  [{ ...T, type: 'replaceSlot', slot: 102, item: 'iron_chestplate' }, '1.21.11', 'item replace entity Steve armor.chest with minecraft:iron_chestplate 1'],
  [{ ...T, type: 'replaceSlot', slot: 103, item: 'iron_helmet' }, '1.21.11', 'item replace entity Steve armor.head with minecraft:iron_helmet 1'],
  [{ ...T, type: 'replaceSlot', slot: -106, item: 'shield' }, '1.21.11', 'item replace entity Steve weapon.offhand with minecraft:shield 1'],
  [{ ...T, type: 'replaceSlot', slot: 0, item: 'iron_sword', enchantments: [{ id: 'sharpness', level: 2 }] }, '1.21.5', 'item replace entity Steve hotbar.0 with minecraft:iron_sword[enchantments={"minecraft:sharpness":2}] 1'],
  [{ ...T, type: 'teleport', to: 'Alex' }, '1.13', 'tp Steve Alex'],
  [{ ...T, type: 'teleport', x: 1, y: 64, z: -3.5 }, '1.21.11', 'tp Steve 1 64 -3.5'],
  [{ ...T, type: 'teleport', x: '12.5', y: '70', z: '-8' }, '1.21.11', 'tp Steve 12.5 70 -8'],
  [{ ...T, type: 'teleport', x: 1e-7, y: 0, z: -1e-7 }, '1.21.11', 'tp Steve 0 0 0'],
  [{ ...T, type: 'teleport', x: 29999999.5, y: 19999999.5, z: -30000000 }, '1.21.11', 'tp Steve 29999999.5 19999999.5 -30000000'],
  [{ ...T, type: 'gamemode', mode: 'survival' }, '1.8', 'gamemode survival Steve'],
  [{ ...T, type: 'gamemode', mode: 'spectator' }, '26.3', 'gamemode spectator Steve'],
  [{ ...T, type: 'gamemode', mode: 'creative' }, '1.21.11', 'gamemode creative Steve'],
  [{ ...T, type: 'gamemode', mode: 'adventure' }, '1.21.11', 'gamemode adventure Steve'],
  [{ ...T, type: 'heal' }, '1.13', 'effect give Steve minecraft:instant_health 1 10 true'],
  [{ ...T, type: 'feed' }, '1.21.11', 'effect give Steve minecraft:saturation 1 19 true'],
  [{ ...T, type: 'effect', effect: 'speed' }, '1.13', 'effect give Steve minecraft:speed 30 0 false'],
  [{ ...T, type: 'effect', effect: 'minecraft:speed', seconds: 60, amplifier: 2, hideParticles: true }, '1.21.11', 'effect give Steve minecraft:speed 60 2 true'],
  [{ ...T, type: 'effect', effect: 'speed', seconds: 'infinite', amplifier: 255 }, '1.19.4', 'effect give Steve minecraft:speed infinite 255 false'],
  [{ ...T, type: 'effect', clear: true }, '1.21.11', 'effect clear Steve'],
  [{ ...T, type: 'effect', clear: true, effect: 'speed' }, '1.21.11', 'effect clear Steve minecraft:speed'],
  [{ ...T, type: 'whisper', text: 'hello there' }, '1.21.11', 'msg Steve hello there'],
  [{ ...T, type: 'whisper', text: 'hi' }, '1.7.10', 'msg Steve hi'],
  [{ ...T, type: 'kick' }, '1.21.11', 'kick Steve'],
  [{ ...T, type: 'kick', reason: 'griefing the spawn' }, '1.21.11', 'kick Steve griefing the spawn'],
  [{ ...T, type: 'ban' }, '1.21.11', 'ban Steve'],
  [{ ...T, type: 'ban', reason: '  ' }, '1.21.11', 'ban Steve'],
  [{ ...T, type: 'ban', reason: 'cheats' }, '26.3', 'ban Steve cheats'],
  [{ ...T, type: 'pardon' }, '1.21.11', 'pardon Steve'],
  [{ ...T, type: 'op' }, '1.21.11', 'op Steve'],
  [{ ...T, type: 'deop' }, '1.21.11', 'deop Steve'],
  [{ ...T, type: 'whitelistAdd' }, '1.21.11', 'whitelist add Steve'],
  [{ ...T, type: 'whitelistRemove' }, '1.7.10', 'whitelist remove Steve'],
  [{ target: '.Bedrock_1', type: 'op' }, '1.21.11', 'op .Bedrock_1'],
];
for (const [action, version, want] of FORMS) same(line(action, version), want, `${action.type} on ${version}`);
for (const kind of ['vanilla', 'paper', 'purpur', 'fabric', 'forge', 'neoforge']) same(line({ ...T, type: 'op' }, '1.21.11', kind), 'op Steve', `kind ${kind}`);
same(line({ ...T, type: 'teleport', to: 'Alex' }, '1.21.11'), 'tp Steve Alex', 'a single teleport line');

const healed = build({ ...T, type: 'heal' }, { version: '1.21.11', kind: 'paper' });
check(/does not revive/.test(healed.note) && /leaves fire/.test(healed.note), 'heal says what it does not do');
check(/food bar/.test(build({ ...T, type: 'feed' }, { version: '1.21.11', kind: 'paper' }).note), 'feed says what it does');
check(!('note' in build({ ...T, type: 'op' }, { version: '1.21.11', kind: 'paper' })), 'other actions have no note');
const frozen = Object.freeze({ ...T, type: 'give', item: 'diamond', enchantments: Object.freeze([Object.freeze({ id: 'sharpness', level: 1 })]) });
same(JSON.stringify(build(frozen, { version: '1.21.5' })), JSON.stringify(build(frozen, { version: '1.21.5' })), 'build is pure');
same(line({ ...T, type: 'give', item: 'bow', enchantments: [{ id: 'power', level: 1 }, { id: 'minecraft:power', level: 2 }] }, '1.21.5'), 'give Steve minecraft:bow[enchantments={"minecraft:power":2}] 1', 'a repeated enchantment is one key');

// ---- actions: versions

const ALL = {
  give: { item: 'stone' }, clear: {}, replaceSlot: { slot: 0, item: 'stone' }, teleport: { to: 'Alex' }, gamemode: { mode: 'survival' }, heal: {}, feed: {},
  effect: { effect: 'speed' }, whisper: { text: 'hi' }, kick: {}, ban: {}, pardon: {}, op: {}, deop: {}, whitelistAdd: {}, whitelistRemove: {},
};
const action = (type, more) => ({ type, target: 'Steve', ...ALL[type], ...more });
same(Object.keys(ALL).length, 16, 'all sixteen actions are covered');
for (const type of Object.keys(ALL)) {
  check(line(action(type), CHECKED_THROUGH).length > 0, `${type} builds on ${CHECKED_THROUGH}`);
  refused(action(type), 'proxy', `${type} on a proxy`, '3.4.0', 'velocity');
  try { build(action(type), { kind: 'paper' }); check(false, `${type} with no version`); } catch (err) { same(err.code, 'version', `${type} with no version`); }
  for (const version of [null, '', 'latest', '1.21.5-pre1', '24w10a', '26.4-snapshot-6', '1.21.5\nstop', '../1.21', '1', 21, {}]) {
    refused(action(type), 'version', `${type} on version ${JSON.stringify(version)}`, version);
  }
  // A new release must not switch off what does not depend on the game's version.
  for (const version of ['26.3.1', '26.4', '27.1', '99.0']) same(line(action(type), version), line(action(type), CHECKED_THROUGH), `${type} on ${version}, past what was checked`);
}
same(CHECKED_THROUGH, '26.3', 'the newest release the forms were checked against');
const ENCHANTED = [{ id: 'sharpness', level: 5 }];
for (const version of ['26.3.1', '26.4', '27.1', '99.0']) {
  refused(action('give', { enchantments: ENCHANTED }), 'version', `give with enchantments on ${version}`, version);
  refused(action('replaceSlot', { enchantments: ENCHANTED }), 'version', `replaceSlot with enchantments on ${version}`, version);
  check(/up to Minecraft 26\.3.*without them/.test(refusal(action('give', { enchantments: ENCHANTED }), version).message), `the refusal on ${version} says what still works`);
}
same(line(action('give', { enchantments: [] }), '26.4'), 'give Steve minecraft:stone 1', 'an empty enchantment list is no item data');
same(line(action('give', { item: 'minecraft:diamond_sword', enchantments: ENCHANTED }), '26.3'), 'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}] 1', 'enchantments on the release that was checked');
refused(action('give'), 'version', 'give on 1.12.2 is still below its floor', '1.12.2');
for (const type of ['give', 'clear', 'teleport', 'heal', 'feed', 'effect']) {
  refused(action(type), 'version', `${type} before 1.13`, '1.12.2');
  check(line(action(type), '1.13').length > 0, `${type} on 1.13`);
}
for (const v of ['1.13', '1.16.5']) refused(action('replaceSlot'), 'version', `replaceSlot on ${v}: /replaceitem's Java form is not confirmed`, v);
same(line(action('replaceSlot'), '1.17.1'), 'item replace entity Steve hotbar.0 with minecraft:stone 1', 'replaceSlot on 1.17.1');
refused(action('gamemode'), 'version', 'gamemode before 1.8', '1.7.10');
refused({ ...T, type: 'effect', effect: 'speed', seconds: 'infinite' }, 'version', 'infinite before 1.19.4', '1.19.3');
for (const type of ['whisper', 'kick', 'ban', 'pardon', 'op', 'deop', 'whitelistAdd', 'whitelistRemove']) check(line(action(type), '1.7.10').length > 0, `${type} never changed`);
same(line({ ...T, type: 'give', item: 'bow', enchantments: [{ id: 'power', level: 1 }] }, '1.20.10'), 'give Steve minecraft:bow[enchantments={levels:{"minecraft:power":1}}] 1', 'versions compare by number, not as text');
refused(action('give'), 'version', '1.9 is older than 1.13 by number', '1.9');

// ---- actions: the shapes of the server's answers. The wordings are en_us.json's, read from the client jars of 1.20.1 and
// 26.3; a line this table calls refused has to read as refused, and the rest as nothing at all.

const ANSWERS = [
  ['give', {}, ['Gave 2 [Diamond Sword] to Steve'], ["Can't give more than 6400 of minecraft:stone"]],
  ['clear', {}, ['Removed 3 item(s) from player Steve'], ['No items were found on player Steve']],
  ['replaceSlot', {}, ['Replaced a slot on Steve with [Stone]', 'Replaced 1 slot(s) on Steve with [Stone]'], ['No targets accepted item into slot 0', 'No targets accepted item [Stone] into slot 0', 'The target does not have slot 0']],
  ['teleport', {}, ['Teleported Steve to Alex', 'Teleported Steve to 1.000000, 2.000000, 3.000000'], ['Invalid position for teleport']],
  ['gamemode', {}, ["Set Steve's game mode to Survival Mode"], []],
  ['heal', {}, ['Applied effect Instant Health to Steve'], ['Unable to apply this effect (target is either immune to effects, or has something stronger)']],
  ['feed', {}, ['Applied effect Saturation to Steve'], ['Unable to apply this effect (target is either immune to effects, or has something stronger)']],
  ['effect', {}, ['Applied effect Speed to Steve'], ['Unable to apply this effect (target is either immune to effects, or has something stronger)']],
  ['effect', { clear: true }, ['Removed every effect from Steve', 'Removed effect Speed from Steve'], ['Target has no effects to remove', "Target doesn't have the requested effect"]],
  ['whisper', {}, ['You whisper to Steve: hi'], []],
  ['kick', {}, ['Kicked Steve: Kicked by an operator'], ['Cannot kick the server owner in a LAN game']],
  ['ban', {}, ['Banned Steve: Banned by an operator.'], ['Nothing changed. The player is already banned']],
  ['pardon', {}, ['Unbanned Steve'], ["Nothing changed. The player isn't banned"]],
  ['op', {}, ['Made Steve a server operator'], ['Nothing changed. The player already is an operator', 'Nothing changed. The player is already an operator']],
  ['deop', {}, ['Made Steve no longer a server operator'], ['Nothing changed. The player is not an operator']],
  ['whitelistAdd', {}, ['Added Steve to the whitelist'], ['Player is already whitelisted']],
  ['whitelistRemove', {}, ['Removed Steve from the whitelist'], ['Player is not whitelisted']],
];
same(new Set(ANSWERS.map(([type]) => type)).size, Object.keys(ALL).length, 'every action has its answers checked');
const ANYONE = ['No player was found', 'No entity was found', 'That player does not exist', 'Only one player is allowed, but the provided selector allows more than one',
  'Only players may be affected by this command, but the provided selector includes entities', 'Unknown or incomplete command, see below for error', 'Unknown or incomplete command. See below for error',
  'Incorrect argument for command', "Unknown item 'minecraft:nope'", "Can't find element 'minecraft:nope' of type 'minecraft:mob_effect'", 'Expected whitespace to end one argument, but found trailing data',
  'Expected integer at position 30: ...stone <--[HERE]', "Malformed 'minecraft:enchantments' component: 'x'", "Item component 'minecraft:x' was repeated, but only one value can be specified", 'Invalid ID',
  'An unexpected error occurred trying to execute that command', 'An unexpected error occurred while trying to execute that command', 'give Steve minecraft:nope<--[HERE]'];
const STRAY = ["Can't keep up! Is the server overloaded? Running 5012ms or 100 ticks behind", 'Disconnecting com.mojang.authlib.GameProfile@1a2b3c[id=<null>,name=Stranger] (/203.0.113.77:50123): Failed to verify username',
  'Disconnecting Stranger (/203.0.113.77:50123)', 'com.mojang.authlib.GameProfile@1a2b3c[id=<null>] (/203.0.113.77:50123) lost connection: Disconnected', 'Stranger lost connection: Timed out',
  'Saving chunks for level ServerLevel[world]', 'Saved the game', 'Alex joined the game', 'Kicked Alex: Griefing', 'Gave 1 [Stone] to Alex', 'Made Alex a server operator', 'Applied effect Speed to Alex'];
for (const [type, more, oks, refusals] of ANSWERS) {
  const { expects } = build(action(type, more), { version: '1.21.11', kind: 'paper' });
  const label = `${type}${more.clear ? ' clear' : ''}`;
  for (const answer of oks) check(expects.ok.test(answer) && !expects.refused.test(answer), `${label}: "${answer}" is its success`);
  for (const answer of [...refusals, ...ANYONE]) check(expects.refused.test(answer), `${label}: "${answer}" is a refusal`);
  for (const answer of STRAY) check(!expects.ok.test(answer) && !expects.refused.test(answer), `${label}: "${answer}" is no answer`);
}
for (const type of Object.keys(ALL)) check(!build(action(type), { version: '1.21.11' }).expects.ok.test('Whatever the server says'), `${type}: any other line is no answer`);
const dotted = build({ type: 'op', target: 'a.b' }, { version: '1.21.11' }).expects;
check(dotted.ok.test('Made a.b a server operator') && !dotted.ok.test('Made axb a server operator'), 'a dot in a name is a dot');
check(build({ type: 'op', target: 'steve' }, { version: '1.21.11' }).expects.ok.test('Made Steve a server operator'), 'the server prints a name in its own case');

// ---- actions: hostile values

for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'stop', '', null, undefined, 3, {}]) refused({ type: kind, target: 'Steve' }, 'action', `action type ${String(kind)}`);
for (const bad of [null, undefined, 'give', 3, []]) refused(bad, 'action', `action ${JSON.stringify(bad)}`);

const NAMES = ['Steve\nop Bob', 'Steve\r\nstop', 'Steve\rstop', 'Steve\n', '\nSteve', 'Steve stop', 'Steve ', ' Steve', '@a', '@p', '@e', '@s', '@r', '@n', '@e[type=player]', '@a[name=Steve]', '*', '#', '"Steve"', 'Steve"', "Steve'", 'Steve;stop', 'Ste\\ve', '../x', 'a:b',
  'a'.repeat(17), 'a'.repeat(100000), '', ' ', 'St\u00e9ve', '\uc2a4\ud2f0\ube0c', `Steve${LS}stop`, `Steve${PS}`, 'Steve\u0000', 'Steve\u0085', 'Steve\t', '{}', '[]', '~', '-', '123e4567-e89b-12d3-a456-426614174000',
  null, undefined, 42, true, {}, [], ['Steve'], { toString: () => 'Steve' }];
for (const type of Object.keys(ALL)) for (const target of NAMES) refused({ ...action(type), target }, 'name', `${type} target ${JSON.stringify(target)?.slice(0, 40)}`);
for (const to of NAMES) if (to !== undefined) refused({ ...T, type: 'teleport', to }, 'name', `teleport to ${JSON.stringify(to)?.slice(0, 40)}`);
check(NAME.test('A_b.9') && NAME.test('a'.repeat(16)), 'plain names pass');

const ITEMS = ['minecraft:stone 64\nstop', 'stone\nop Bob', 'stone\r\nstop', 'stone 64', 'stone{display:{Name:"x"}}', 'stone[custom_name="x"]', 'stone[', 'stone{', '#minecraft:logs', 'Minecraft:Stone', 'STONE', 'a:b:c', ':stone', 'stone:', '', ' ', '@a', '"stone"', 'x'.repeat(129), 'x'.repeat(100000), `stone${LS}stop`, 'stone\\', null, 42, {}, [], true];
for (const item of ITEMS) {
  refused({ ...T, type: 'give', item }, 'item', `give ${JSON.stringify(item)?.slice(0, 40)}`);
  refused({ ...T, type: 'replaceSlot', slot: 0, item }, 'item', `replaceSlot ${JSON.stringify(item)?.slice(0, 40)}`);
  if (item !== undefined) refused({ ...T, type: 'clear', item }, 'item', `clear ${JSON.stringify(item)?.slice(0, 40)}`);
}
refused({ ...T, type: 'give' }, 'item', 'give without an item');
for (const id of ITEMS) {
  refused({ ...T, type: 'give', item: 'bow', enchantments: [{ id, level: 1 }] }, 'enchantment', `enchantment ${JSON.stringify(id)?.slice(0, 40)}`);
  refused({ ...T, type: 'effect', effect: id }, 'effect', `effect ${JSON.stringify(id)?.slice(0, 40)}`);
  if (id !== undefined) refused({ ...T, type: 'effect', clear: true, effect: id }, 'effect', `effect clear ${JSON.stringify(id)?.slice(0, 40)}`);
}
for (const list of ['sharpness', 3, {}, Array.from({ length: 65 }, () => ({ id: 'a', level: 1 }))]) refused({ ...T, type: 'give', item: 'bow', enchantments: list }, 'enchantment', `enchantment list ${String(list).slice(0, 20)}`);
refused({ ...T, type: 'give', item: 'bow', enchantments: [null] }, 'enchantment', 'a null enchantment');
for (const level of [0, -1, 256, 1.5, '5', '5}]} 1\nstop', null, undefined, NaN, Infinity]) refused({ ...T, type: 'give', item: 'bow', enchantments: [{ id: 'power', level }] }, 'enchantment level', `level ${String(level).slice(0, 20)}`);
for (const count of [0, -1, 6401, 1.5, '1', '1\nstop', NaN, Infinity, {}]) refused({ ...T, type: 'give', item: 'stone', count }, 'count', `give count ${String(count).slice(0, 20)}`);
for (const count of [0, -1, 65, 1.5, '1']) refused({ ...T, type: 'replaceSlot', slot: 0, item: 'stone', count }, 'count', `slot count ${count}`);
for (const count of [0, -1, 2147483648, 1.5, '1', null]) refused({ ...T, type: 'clear', item: 'stone', count }, 'count', `clear count ${count}`);
for (const slot of [36, 99, 98, 104, -1, -105, '0', 1.5, null, undefined, 'hotbar.0', 'hotbar.0 with minecraft:stone\nstop']) refused({ ...T, type: 'replaceSlot', slot, item: 'stone' }, 'slot', `slot ${String(slot).slice(0, 20)}`);
for (const mode of ['s', 'c', 0, 1, 'hardcore', 'survival\nop Bob', 'survival Steve', '', null, undefined, 'constructor']) refused({ ...T, type: 'gamemode', mode }, 'gamemode', `mode ${String(mode)}`);
for (const [x, y, z] of [[NaN, 0, 0], [Infinity, 0, 0], [0, -Infinity, 0], [1e21, 0, 0], [30000000, 0, 0], [-30000001, 0, 0], [0, 20000000, 0], [0, -20000001, 0], [0, 0, 30000000], ['~', 0, 0], ['~1', 0, 0], ['^', 0, 0], ['1 2', 0, 0], ['1e3', 0, 0], ['0x10', 0, 0], ['1\nstop', 0, 0], ['', 0, 0], [undefined, 0, 0], [null, 0, 0], [{}, 0, 0], [[], 0, 0], [true, 0, 0]]) {
  refused({ ...T, type: 'teleport', x, y, z }, 'coordinates', `coordinates ${String(x)},${String(y)},${String(z)}`);
}
for (const seconds of [0, -1, 1000001, 1.5, '30', '30 0 false\nstop', 'forever']) refused({ ...T, type: 'effect', effect: 'speed', seconds }, 'duration', `seconds ${seconds}`);
for (const amplifier of [-1, 256, 1.5, '0']) refused({ ...T, type: 'effect', effect: 'speed', amplifier }, 'amplifier', `amplifier ${amplifier}`);
same(line({ ...T, type: 'effect', effect: 'speed', hideParticles: 'true\nstop' }), 'effect give Steve minecraft:speed 30 0 false', 'hideParticles is only ever true or false');

const MESSAGES = [
  ['hi\nop Bob', 'hi op Bob'], ['hi\r\nstop', 'hi stop'], ['hi\rstop', 'hi stop'], ['\n\nstop', 'stop'], ['a\n\n\nb', 'a b'], [`a${LS}stop`, 'a stop'], [`a${PS}stop`, 'a stop'],
  ['a\u0085stop', 'a stop'], ['a\u0000stop', 'a stop'], ['a\u001b[31mstop', 'a [31mstop'], ['a\u000bb\u000cc', 'a b c'], ['tab\there', 'tab here'],
  ['say "hi" and \'bye\'', 'say "hi" and \'bye\''], ['back\\slash\\', 'back\\slash\\'], ['/stop', '/stop'], ['{"text":"x"}', '{"text":"x"}'],
  ['@a', `${FULL_AT}a`], ['look @e[type=player] now', `look ${FULL_AT}e[type=player] now`], ['@s@p@r@n', `${FULL_AT}s${FULL_AT}p${FULL_AT}r${FULL_AT}n`], ['me@example.com', `me${FULL_AT}example.com`],
  ['\uc548\ub155\ud558\uc138\uc694', '\uc548\ub155\ud558\uc138\uc694'], ['x'.repeat(256), 'x'.repeat(256)],
];
for (const [text, want] of MESSAGES) {
  same(line({ ...T, type: 'whisper', text }), `msg Steve ${want}`, `whisper ${JSON.stringify(text).slice(0, 30)}`);
  same(line({ ...T, type: 'kick', reason: text }), `kick Steve ${want}`, `kick reason ${JSON.stringify(text).slice(0, 30)}`);
  same(line({ ...T, type: 'ban', reason: text }), `ban Steve ${want}`, `ban reason ${JSON.stringify(text).slice(0, 30)}`);
}
for (const text of ['x'.repeat(257), 'x'.repeat(1000000), 3, {}, [], true]) {
  refused({ ...T, type: 'whisper', text }, 'text', `whisper ${String(text).slice(0, 20)}`);
  refused({ ...T, type: 'kick', reason: text }, 'text', `kick ${String(text).slice(0, 20)}`);
  refused({ ...T, type: 'ban', reason: text }, 'text', `ban ${String(text).slice(0, 20)}`);
}
for (const text of ['', '   ', '\n\r\n', null, undefined]) refused({ ...T, type: 'whisper', text }, 'text', `an empty whisper ${JSON.stringify(text)}`);

// Every action with every hostile value in every field: it is refused, or it is one line of the action's own shape.
const SHAPES = {
  give: /^give Steve [a-z0-9_.:/-]+(\[[a-z_]+=\{[^\s]*\}\]|\{[A-Za-z]+:\[[^\s]*\]\})? \d+$/, clear: /^clear Steve( [a-z0-9_.:/-]+( \d+)?)?$/,
  replaceSlot: /^item replace entity Steve [a-z.]+(\.\d+)? with [a-z0-9_.:/-]+ \d+$/, teleport: /^tp Steve ([\w.]+|-?[\d.]+ -?[\d.]+ -?[\d.]+)$/, gamemode: /^gamemode [a-z]+ Steve$/,
  heal: /^effect give Steve minecraft:instant_health 1 10 true$/, feed: /^effect give Steve minecraft:saturation 1 19 true$/,
  effect: /^effect (give Steve [a-z0-9_.:/-]+ (\d+|infinite) \d+ (true|false)|clear Steve( [a-z0-9_.:/-]+)?)$/, whisper: /^msg Steve [^@\n\r]+$/, kick: /^kick Steve( [^@\n\r]+)?$/, ban: /^ban Steve( [^@\n\r]+)?$/,
  pardon: /^pardon Steve$/, op: /^op Steve$/, deop: /^deop Steve$/, whitelistAdd: /^whitelist add Steve$/, whitelistRemove: /^whitelist remove Steve$/,
};
const HOSTILE = [...NAMES, ...ITEMS, ...MESSAGES.map((m) => m[0]), -1, 1e21, NaN];
const FIELDS = ['item', 'count', 'slot', 'to', 'x', 'y', 'z', 'mode', 'effect', 'seconds', 'amplifier', 'hideParticles', 'clear', 'text', 'reason', 'enchantments'];
let shapes = 0;
let shapeFailures = 0;
for (const type of Object.keys(ALL)) {
  for (const field of FIELDS) {
    for (const value of HOSTILE) {
      const a = { ...action(type), [field]: value };
      const r = refusal(a);
      shapes++;
      if (r.unexpected || (!r.commands && !r.expected)) { shapeFailures++; console.log(`FAIL: ${type}.${field} threw ${r.unexpected}`); continue; }
      if (!r.commands) continue;
      const ok = r.commands.length === 1 && !/[\p{Cc}]/u.test(r.commands[0]) && !r.commands[0].includes(LS) && !r.commands[0].includes(PS) && SHAPES[type].test(r.commands[0]);
      if (!ok) { shapeFailures++; console.log(`FAIL: ${type}.${field} ${JSON.stringify(value)?.slice(0, 40)} gave ${JSON.stringify(r.commands)?.slice(0, 120)}`); }
    }
  }
}
same(shapeFailures, 0, `${shapes} hostile combinations keep the shape of the command`);

// ---- items: fixtures

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(Buffer.from(type, 'latin1'))), 0);
  return Buffer.concat([head, data, crc]);
};
// A Sub filter on every row after the first, so a cut only stands if rows decode alone from the top.
function png(width, height, color) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = y ? 1 : 0;
    let last = [0, 0, 0, 0];
    for (let x = 0; x < width; x++) {
      const c = color(x, y);
      for (let k = 0; k < 4; k++) row[1 + x * 4 + k] = (c[k] - (y ? last[k] : 0)) & 255;
      last = c;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('tEXt', Buffer.from('Comment\0x')), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}
function unpng(url) {
  const data = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  const chunks = {};
  for (let at = 8; at + 12 <= data.length;) {
    const size = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    chunks[type] = Buffer.concat([chunks[type] || Buffer.alloc(0), data.subarray(at + 8, at + 8 + size)]);
    const crc = zlib.crc32(data.subarray(at + 8, at + 8 + size), zlib.crc32(data.subarray(at + 4, at + 8)));
    if (crc !== data.readUInt32BE(at + 8 + size)) throw new Error(`bad crc in ${type}`);
    at += 12 + size;
  }
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  const raw = zlib.inflateSync(chunks.IDAT);
  const pixel = (x, y) => {
    const stride = 1 + width * 4;
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const out = [0, 0, 0, 0];
    for (let i = 0; i <= x; i++) for (let k = 0; k < 4; k++) out[k] = row[0] === 1 ? (out[k] + row[1 + i * 4 + k]) & 255 : row[1 + i * 4 + k];
    return out;
  };
  return { width, height, raw, pixel, chunks };
}
const solid = (r) => png(16, 16, () => [r, 10, 20, 255]);
// A small file whose header claims a strip of a million frames.
function tallPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(1024 * 1024))), pngChunk('IEND', Buffer.alloc(0))]);
}
const json = (o) => Buffer.from(JSON.stringify(o));
const generated = (texture, more) => json({ parent: 'minecraft:item/generated', textures: { layer0: texture, ...more } });
const STAND_IN_ITEMS = ['diamond', 'stone', 'grass_block', 'oak_log', 'leather_helmet', 'potion', 'compass', 'clock', 'shield', 'chest', 'water_bucket', 'bedrock', 'torch', 'player_head', 'barrier', 'odd_strip'];
const textures = {
  'item/diamond': solid(1), 'block/stone': solid(2), 'block/grass_block_side': solid(3), 'block/grass_block_top': solid(4), 'block/oak_log': solid(5), 'block/oak_log_top': solid(6),
  'item/leather_helmet': solid(7), 'item/leather_helmet_overlay': solid(8), 'item/potion': solid(9), 'item/potion_overlay': solid(10),
  'item/compass_16': png(16, 48, (x, y) => [Math.floor(y / 16) * 50 + 40, x * 10, y, 255]), 'item/clock_00': solid(12), 'item/shield_base': solid(13), 'block/oak_planks': solid(14),
  'item/water_bucket': solid(15), 'block/bedrock': solid(16), 'block/torch': solid(17), 'item/odd_strip': png(16, 40, () => [1, 2, 3, 255]),
};
const assetFiles = () => {
  const files = [];
  for (const [t, data] of Object.entries(textures)) files.push({ name: `assets/minecraft/textures/${t}.png`, data });
  const models = {
    'block/cube_all': { parent: 'block/cube', textures: { particle: '#all' } },
    'block/stone': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
    'block/grass_block': { parent: 'minecraft:block/block', textures: { top: 'minecraft:block/grass_block_top', side: 'minecraft:block/grass_block_side', particle: '#side' } },
    'block/oak_log': { textures: { end: 'minecraft:block/oak_log_top', side: '#base' , base: 'block/oak_log' } },
    'item/diamond': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/diamond' } },
    'item/leather_helmet': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/leather_helmet', layer1: 'minecraft:item/leather_helmet_overlay' } },
    'item/potion': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/potion_overlay', layer1: 'minecraft:item/potion' } },
    'item/compass_16': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/compass_16' } },
    'item/clock_00': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/clock_00' } },
    'item/shield': { textures: { particle: 'minecraft:item/shield_base' } },
    'item/chest': { parent: 'minecraft:item/template_chest', textures: { particle: 'minecraft:block/oak_planks' } },
    'item/torch': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:block/torch' } },
    'item/template_player_head': { parent: 'minecraft:builtin/entity' },
    'item/barrier': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/no_such_texture' } },
    'item/odd_strip': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/odd_strip' } },
  };
  for (const [m, body] of Object.entries(models)) files.push({ name: `assets/minecraft/models/${m}.json`, data: json(body) });
  return files;
};
const lang = Object.fromEntries([...STAND_IN_ITEMS.map((id) => [`${['stone', 'grass_block', 'oak_log', 'chest', 'bedrock', 'torch', 'player_head', 'barrier'].includes(id) ? 'block' : 'item'}.minecraft.${id}`, id.replace(/(^|_)(\w)/g, (_m, s, c) => (s ? ' ' : '') + c.toUpperCase())]), ['block.minecraft.water', 'Water'], ['block.minecraft.air', 'Air'], ['item.minecraft.not_in_the_jar', 'Ghost'], ['advancements.foo', 'Nope'],
  ['enchantment.minecraft.sharpness', 'Sharpness'], ['enchantment.minecraft.luck_of_the_sea', 'Luck of the Sea'], ['enchantment.minecraft.sharpness.desc', 'A description'], ['enchantment.level.1', 'I'],
  ['enchantment.minecraft.sweeping', 'Sweeping Edge'], ['enchantment.minecraft.sweeping_edge', 'Sweeping Edge'],
  ['effect.minecraft.speed', 'Speed'], ['effect.minecraft.bad_omen', 'Bad Omen'], ['effect.none', 'No Effects'], ['effect.duration.infinite', 'Infinite']]);
const korean = Object.fromEntries([['item.minecraft.diamond', '\ub2e4\uc774\uc544\ubaac\ub4dc'], ['block.minecraft.stone', '\ub3cc'], ['item.minecraft.potion', '\ubb3c\uc57d'],
  ['enchantment.minecraft.sharpness', '\ub0a0\uce74\ub85c\uc6c0'], ['effect.minecraft.speed', '\uc18d\ub3c4 \uc99d\uac00']]);
const asItem = (id) => (['stone', 'grass_block', 'oak_log', 'torch', 'bedrock'].includes(id) ? `minecraft:${id === 'torch' ? 'item' : 'block'}/${id}` : `minecraft:item/${id}`);
// The 1.21.4 layout: one definition per item, of every kind of model tree.
function definitionJar() {
  const defs = {
    compass: { type: 'minecraft:range_dispatch', property: 'minecraft:compass', scale: 32, entries: [{ threshold: 0, model: { type: 'minecraft:model', model: 'minecraft:item/compass_16' } }], fallback: { type: 'minecraft:model', model: 'minecraft:item/compass_16' } },
    clock: { type: 'minecraft:condition', property: 'minecraft:using_item', on_true: { type: 'minecraft:model', model: 'minecraft:item/no_such' }, on_false: { type: 'minecraft:select', property: 'minecraft:context_dimension', cases: [{ when: 'minecraft:overworld', model: { type: 'minecraft:model', model: 'minecraft:item/clock_00' } }] } },
    shield: { type: 'minecraft:composite', models: [{ type: 'minecraft:model', model: 'minecraft:item/shield' }] },
    chest: { type: 'minecraft:special', base: 'minecraft:item/chest', model: { type: 'minecraft:chest', texture: 'minecraft:normal' } },
    player_head: { type: 'minecraft:special', base: 'minecraft:item/template_player_head', model: { type: 'minecraft:player_head' } },
  };
  const files = [{ name: 'assets/minecraft/lang/en_us.json', data: json(lang) }, ...assetFiles()];
  for (const id of [...STAND_IN_ITEMS, 'air']) {
    if (id === 'water_bucket' || id === 'bedrock') files.push({ name: `assets/minecraft/items/${id}.json`, data: json({ model: { type: 'minecraft:model', model: `minecraft:item/${id}` } }) });
    else files.push({ name: `assets/minecraft/items/${id}.json`, data: json({ model: defs[id] || { type: 'minecraft:model', model: asItem(id), tints: [{ type: 'minecraft:dye', default: -6265536 }] } }) });
  }
  return writeZip(files);
}
// Older: models/item with its templates and animation frames, and no definitions.
function modelJar() {
  const models = {
    diamond: { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/diamond' } }, stone: { parent: 'minecraft:block/stone' }, compass: { parent: 'minecraft:item/compass_16' }, bedrock: { parent: 'minecraft:item/generated' },
    generated: { parent: 'builtin/generated' }, handheld: { parent: 'minecraft:item/generated' }, compass_16: { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/compass_16' } }, bow_pulling_0: { parent: 'minecraft:item/generated' }, air: {},
  };
  const files = [{ name: 'assets/minecraft/lang/en_us.json', data: json(lang) }];
  for (const f of assetFiles()) if (!f.name.includes('/models/item/')) files.push(f);
  for (const [id, body] of Object.entries(models)) files.push({ name: `assets/minecraft/models/item/${id}.json`, data: json(body) });
  return writeZip(files);
}
const hashed = (data) => ({ hash: sha1(data), size: data.length });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'players-items-'));
const hits = [];
const state = { jar503: 0, badJar: false, badKo: false, noKo: false, wrongSize: false, foreign: false, badIndex: false };
const koFile = Buffer.from(JSON.stringify(korean));
const JARS = { '1.21.11': definitionJar(), '1.20.1': modelJar(), '1.21.4': definitionJar(), '1.21.8': definitionJar(), '1.21.9': definitionJar(), '1.21.10': definitionJar(), '26.3': definitionJar(), '26.1': definitionJar(), '26.2': definitionJar() };
let origin = '';
const versionJson = (id) => {
  const jar = JARS[id];
  const index = Buffer.from(JSON.stringify({ objects: state.noKo ? {} : { 'minecraft/lang/ko_kr.json': hashed(koFile), 'minecraft/lang/en_gb.json': { hash: 'a'.repeat(40), size: 1 } } }));
  return Buffer.from(JSON.stringify({
    id,
    assetIndex: { id: '27', sha1: sha1(index), size: index.length, url: `${origin}/index/${id}.json` },
    downloads: { client: { sha1: sha1(jar), size: state.wrongSize ? jar.length + 1 : jar.length, url: state.foreign ? 'https://example.invalid/client.jar' : `${origin}/client/${id}.jar` } },
  }));
};
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const send = (data, status = 200) => { res.writeHead(status); res.end(data); };
  const m = req.url.match(/^\/(v|client|index)\/(.+)\.(json|jar)$/);
  if (req.url === '/manifest.json') {
    const ids = Object.keys(JARS);
    const entry = (id) => ({ id, type: 'release', url: `${origin}/v/${id}.json`, sha1: sha1(versionJson(id)) });
    return send(JSON.stringify({ latest: { release: '26.3' }, versions: [...ids.map(entry), { id: '1.19', type: 'release', url: 'https://example.invalid/v.json', sha1: 'b'.repeat(40) }, { id: '1.19.1', type: 'release', url: `${origin}/v/1.21.11.json`, sha1: 'c'.repeat(40) }] }));
  }
  if (m?.[1] === 'v') return send(versionJson(m[2]));
  if (m?.[1] === 'client') {
    if (state.jar503 > 0) { state.jar503--; return send('later', 503); }
    return send(state.badJar ? Buffer.concat([JARS[m[2]].subarray(0, -1), Buffer.from([1])]) : JARS[m[2]]);
  }
  if (m?.[1] === 'index') {
    return send(state.badIndex ? '{}' : Buffer.from(JSON.stringify({ objects: state.noKo ? {} : { 'minecraft/lang/ko_kr.json': hashed(koFile), 'minecraft/lang/en_gb.json': { hash: 'a'.repeat(40), size: 1 } } })));
  }
  if (req.url === `/assets/${sha1(koFile).slice(0, 2)}/${sha1(koFile)}`) return send(state.badKo ? Buffer.from('{}') : koFile);
  return send('no', 404);
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
origin = `http://127.0.0.1:${server.address().port}`;
process.env.PYIDE_MC_SOURCES = JSON.stringify({ mojang: `${origin}/manifest.json`, mojangAssets: `${origin}/assets` });

const cache = path.join(work, 'cache');
const opts = (version, more) => ({ dir: path.join(work, 'no-such-server'), version, cacheDir: cache, ...more });
const byId = (list) => new Map(list.map((i) => [i.id, i]));
const pathsUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

// ---- items: the game's catalog

const concurrent = await Promise.all([items.catalog(opts('1.21.11'), ''), items.catalog(opts('1.21.11'), 'dia')]);
same(hits.filter((u) => u.startsWith('/client/')).length, 1, 'two calls at once download the jar once');
const first = concurrent[0];
same(first.reason, null, 'a full catalog has no reason');
same(first.length, 16, 'one item per definition, without air');
same(first.coverage.items, 16, 'coverage counts the items');
const got = byId(first);
const coverage = first.coverage;
check(!got.has('minecraft:air') && !got.has('minecraft:water') && !got.has('minecraft:not_in_the_jar'), 'only what has a definition is an item');
same(got.get('minecraft:diamond').name, 'Diamond', 'the English name');
same(got.get('minecraft:diamond').ko, korean['item.minecraft.diamond'], 'the Korean name');
same(got.get('minecraft:stone').ko, korean['block.minecraft.stone'], 'a block\'s Korean name');
same(got.get('minecraft:clock').ko, null, 'no Korean name is null');
same(got.get('minecraft:diamond').mod, null, 'the game\'s items have no mod');
const firstRed = (id) => unpng(got.get(`minecraft:${id}`).icon).pixel(0, 0)[0];
for (const [id, red, kind] of [['diamond', 1, 'a flat item'], ['stone', 2, 'a cube block'], ['grass_block', 3, 'a block by its side'], ['oak_log', 5, 'a #reference'], ['leather_helmet', 7, 'a layered item by its base'], ['potion', 9, 'not the liquid overlay'], ['clock', 12, 'condition and select'], ['shield', 13, 'composite'], ['chest', 14, 'special by its base'], ['water_bucket', 15, 'no model, a flat item texture'], ['bedrock', 16, 'no model, a flat block texture'], ['torch', 17, 'an item from a block texture']]) {
  check(got.get(`minecraft:${id}`).icon?.startsWith('data:image/png;base64,'), `${kind} has an icon`);
  same(firstRed(id), red, kind);
}
for (const id of ['player_head', 'barrier', 'odd_strip']) same(got.get(`minecraft:${id}`).icon, null, `${id} falls back to a blank tile`);
const strip = unpng(got.get('minecraft:compass').icon);
check(strip.width === 16 && strip.height === 16, `an animated strip keeps its first frame, ${strip.width}x${strip.height}`);
same(strip.raw.length, 65 * 16, 'only the first frame\'s rows are left');
same(strip.pixel(15, 15).join(), [40, 150, 15, 255].join(), 'the frame\'s last pixel decodes');
check(!strip.chunks.tEXt, 'a cut strip drops other chunks');
same(pathsUnder(path.join(cache, '1.21.11')).join(), 'items.json', 'the cache keeps one file, and no jar');

hits.length = 0;
const again = await items.catalog(opts('1.21.11'), 'stone');
same(hits.length, 0, 'the next call needs no network');
same(again[0]?.id, 'minecraft:stone', 'a search by id');
items.reset();
const fromDisk = await items.catalog(opts('1.21.11'), '');
same(hits.length, 0, 'the cache file serves a new session');
same(fromDisk.length, 16, 'the cache file holds the catalog');

same((await items.catalog(opts('1.21.11'), 'Diamond'))[0]?.id, 'minecraft:diamond', 'a search by English name');
same((await items.catalog(opts('1.21.11'), '\ub2e4\uc774\uc544'))[0]?.id, 'minecraft:diamond', 'a search by Korean name');
same((await items.catalog(opts('1.21.11'), '\u1103\u1161\u110b\u1175\u110b\u1161'))[0]?.id, 'minecraft:diamond', 'a Korean query in decomposed form');
same((await items.catalog(opts('1.21.11'), 'minecraft:stone'))[0]?.id, 'minecraft:stone', 'a search by full id');
same((await items.catalog(opts('1.21.11'), 'no-such-item')).length, 0, 'a search with no match');
for (const q of [null, undefined, 3, {}, [], 'x'.repeat(100000), '(', '.*', '\\']) check(Array.isArray(await items.catalog(opts('1.21.11'), q)), `query ${String(q).slice(0, 12)} is harmless`);
same(await items.icon(opts('1.21.11'), 'diamond'), got.get('minecraft:diamond').icon, 'icon by short id');
same(await items.icon(opts('1.21.11'), 'minecraft:barrier'), null, 'icon of a blank tile');
same(await items.icon(opts('1.21.11'), 'minecraft:nothing'), null, 'icon of an unknown id');
const looked = await items.icons(opts('1.21.11'), ['diamond', 'minecraft:stone', 'minecraft:nothing', 5, null]);
same(Object.keys(looked).sort().join(), 'minecraft:diamond,minecraft:stone', 'icons for an inventory');
same(looked['minecraft:stone'].name, 'Stone', 'icons give names as well');

const old = byId(await items.catalog(opts('1.20.1'), ''));
same([...old.keys()].join(), 'minecraft:bedrock,minecraft:compass,minecraft:diamond,minecraft:stone', 'before 1.21.4 a model counts only with a language name');
same(old.get('minecraft:stone').name, 'Stone', 'and is named by it');
same(unpng(old.get('minecraft:stone').icon).pixel(0, 0)[0], 2, 'a block model through its parent');
same(old.get('minecraft:bedrock').icon && unpng(old.get('minecraft:bedrock').icon).pixel(0, 0)[0], 16, 'a flat lookup when the model names no texture');

// ---- names: enchantments and effects, from the same language files

const names = await items.names(opts('1.21.11'));
same(JSON.stringify(names.enchantments), JSON.stringify([{ id: 'minecraft:luck_of_the_sea', name: 'Luck of the Sea', ko: null }, { id: 'minecraft:sharpness', name: 'Sharpness', ko: korean['enchantment.minecraft.sharpness'] }, { id: 'minecraft:sweeping_edge', name: 'Sweeping Edge', ko: null }]), 'enchantments with both names, no description or level keys, and no key left from a rename');
same(JSON.stringify(names.effects), JSON.stringify([{ id: 'minecraft:bad_omen', name: 'Bad Omen', ko: null }, { id: 'minecraft:speed', name: 'Speed', ko: korean['effect.minecraft.speed'] }]), 'effects with both names, and no effect.none');
same(names.reason, undefined, 'a full list has no reason');
same(Object.keys(names).join(), 'enchantments,effects', 'the shape the tab builds on');
same(JSON.stringify(v8.deserialize(v8.serialize(names))), JSON.stringify(names), 'the shape survives the copy IPC makes');
items.reset();
hits.length = 0;
same(JSON.stringify(await items.names(opts('1.21.11'))), JSON.stringify(names), 'names come from the cache file in a new session');
same(hits.length, 0, 'without the network');

// ---- items: what goes wrong

state.jar503 = 2;
same((await items.catalog(opts('1.21.8'), '')).length, 16, 'a 503 is asked again');
same(state.jar503, 0, 'both 503s were served');

state.badJar = true;
let bad = await items.catalog(opts('1.21.9'), '');
same(bad.length, 0, 'a tampered jar gives no list');
check(/Checksum mismatch/.test(bad.reason), `the reason says so: ${bad.reason}`);
same(bad.reasonCode, 'download', 'with a code');
check(!fs.existsSync(path.join(cache, '1.21.9', 'items.json')), 'a tampered jar leaves no cache');
same(pathsUnder(path.join(cache, '1.21.9')).length, 0, 'and no partial file');
state.badJar = false;
hits.length = 0;
bad = await items.catalog(opts('1.21.9'), '');
same(hits.length, 0, 'a failure is not asked again on the next key press');
check(/Checksum mismatch/.test(bad.reason), 'it keeps its reason meanwhile');
items.reset();
same((await items.catalog(opts('1.21.9'), '')).length, 16, 'a later try succeeds');

state.badKo = true;
items.reset();
let noKo = await items.catalog(opts('1.21.10'), '');
same(noKo.length, 16, 'a bad Korean file leaves the English catalog');
same(noKo.reasonCode, 'korean', 'and says so');
same(byId(noKo).get('minecraft:diamond').ko, null, 'without Korean names');
const namesNoKo = await items.names(opts('1.21.10'));
check(namesNoKo.enchantments.every((e) => e.ko === null) && namesNoKo.enchantments.length === 3, 'a bad Korean file leaves the enchantments in English');
same(namesNoKo.reasonCode, 'korean', 'and says so');
hits.length = 0;
noKo = await items.catalog(opts('1.21.10'), '');
same(hits.length, 0, 'the failed part is not asked again at once');
same(noKo.length, 16, 'the English list stays');
state.badKo = false;
items.reset();
noKo = await items.catalog(opts('1.21.10'), '');
same(noKo.reason, null, 'Korean names arrive later');
same(byId(noKo).get('minecraft:diamond').ko, korean['item.minecraft.diamond'], 'in the same cache');
same((await items.names(opts('1.21.10'))).enchantments.find((e) => e.id === 'minecraft:sharpness').ko, korean['enchantment.minecraft.sharpness'], 'for names as well');
same(hits.filter((u) => u.startsWith('/client/')).length, 0, 'without the jar again');

state.noKo = true;
const plain = await items.catalog(opts('26.1'), '');
same(plain.reason, null, 'a version without Korean names is no failure');
same(byId(plain).get('minecraft:diamond').ko, null, 'and has none');
state.noKo = false;

state.wrongSize = true;
bad = await items.catalog(opts('26.2'), '');
check(bad.length === 0 && /Checksum mismatch/.test(bad.reason), 'a size that does not match is refused');
state.wrongSize = false;
items.reset();

state.foreign = true;
hits.length = 0;
bad = await items.catalog(opts('26.3'), '');
check(bad.length === 0 && /no usable client jar/.test(bad.reason), `a client jar outside Mojang is refused: ${bad.reason}`);
state.foreign = false;
items.reset();

for (const [version, pattern] of [['1.19', /points outside Mojang/], ['1.19.1', /Checksum mismatch/], ['9.9', /not in Mojang's version list/], ['1.12.2', /need 1\.13/], ['1.7.10', /need 1\.13/]]) {
  const list = await items.catalog(opts(version), '');
  check(list.length === 0 && pattern.test(list.reason), `version ${version}: ${list.reason}`);
}
same((await items.catalog(opts('9.9'), '')).reasonCode, 'version', 'an unknown version has its code');
for (const version of ['../../evil', '..\\..\\evil', '1.21/../../evil', 'C:\\evil', '', null, undefined, 5, {}, '1.21.5-pre1', '26.4-snapshot-6']) {
  const list = await items.catalog(opts(version), '');
  check(list.length === 0 && list.reasonCode === 'version', `version ${JSON.stringify(version)} is refused`);
}
check(!fs.existsSync(path.join(work, 'evil')) && !fs.existsSync(path.join(cache, '..', '..', 'evil')), 'no version leaves the cache');
same((await items.catalog(null, 'x')).reasonCode, 'version', 'no options at all do not throw');
same(JSON.stringify(await items.icons(null, null)), '{}', 'icons without options');
same(await items.icon(undefined, undefined), null, 'icon without options');

fs.mkdirSync(path.join(cache, '26.2'), { recursive: true });
fs.writeFileSync(path.join(cache, '26.2', 'items.json'), '{"format":2,"items":[{"id"');
items.reset();
same((await items.catalog(opts('26.2'), '')).length, 16, 'a broken cache file is rebuilt');
fs.writeFileSync(path.join(cache, '26.2', 'items.json'), '{"format":1,"version":"26.2","items":[{"id":"minecraft:stone","name":"Stone"}]}');
items.reset();
same((await items.names(opts('26.2'))).enchantments.length, 3, 'a cache file from before names were kept is rebuilt');
fs.writeFileSync(path.join(cache, '26.2', 'items.json'), '{"format":2,"version":"26.2","items":[{"id":5}]}');
items.reset();
const garbage = await items.catalog(opts('26.2'), 'x');
check(Array.isArray(garbage) && garbage.reasonCode === 'error', 'a cache with garbage items does not throw');
fs.rmSync(path.join(cache, '26.2'), { recursive: true });
fs.writeFileSync(path.join(cache, 'blocked'), 'a file where a folder is wanted');
items.reset();
const blocked = await items.catalog({ ...opts('26.2'), cacheDir: path.join(cache, 'blocked') }, '');
check(Array.isArray(blocked) && blocked.length === 0 && !!blocked.reason, `an unusable cache folder is a reason: ${blocked.reason}`);

const shipped = v8.deserialize(v8.serialize(await items.catalog(opts('9.9'), '')));
check(!!shipped.reason, 'the reason survives the copy IPC makes');
same(items.defaultCacheDir().startsWith(path.resolve('.')), false, 'the shared cache is not in the repo');
check(/minecraft-items$/.test(items.defaultCacheDir()), 'the shared cache is under the install root');

// ---- items: mods

const modsDir = path.join(work, 'server', 'mods');
fs.mkdirSync(modsDir, { recursive: true });
const modAssets = (ns) => [
  { name: `assets/${ns}/lang/en_us.json`, data: json({ [`item.${ns}.wrench`]: 'Wrench', [`block.${ns}.gear`]: 'Gear', [`item.${ns}.loop`]: 'Loop', [`item.${ns}.deep`]: 'Deep', [`item.${ns}.far`]: 'Far', [`item.${ns}.tall`]: 'Tall', [`item.${ns}.huge`]: 'Huge', [`item.${ns}.notpng`]: 'Not a PNG' }) },
  { name: `assets/${ns}/lang/ko_kr.json`, data: json({ [`item.${ns}.wrench`]: '\ub80c\uce58' }) },
  { name: `assets/${ns}/models/item/wrench.json`, data: json({ parent: 'minecraft:item/handheld', textures: { layer0: `${ns}:item/wrench` } }) },
  { name: `assets/${ns}/textures/item/wrench.png`, data: solid(40) },
  { name: `assets/${ns}/models/item/gear.json`, data: json({ parent: `${ns}:block/gear` }) },
  { name: `assets/${ns}/models/block/gear.json`, data: json({ parent: 'minecraft:block/cube_all', textures: { all: `${ns}:block/gear` } }) },
  { name: `assets/${ns}/textures/block/gear.png`, data: solid(41) },
  { name: `assets/${ns}/models/item/helper_template.json`, data: json({ parent: 'minecraft:item/generated' }) },
  { name: `assets/${ns}/models/item/loop.json`, data: json({ parent: `${ns}:item/loop2` }) },
  { name: `assets/${ns}/models/item/loop2.json`, data: json({ parent: `${ns}:item/loop` }) },
  { name: `assets/${ns}/models/item/far.json`, data: json({ parent: '../../../../secret', textures: { layer0: '../../../../secret' } }) },
  { name: `assets/${ns}/models/item/tall.json`, data: json({ textures: { layer0: `${ns}:item/tall` } }) },
  { name: `assets/${ns}/textures/item/tall.png`, data: tallPng(16, 16 * 1000000) },
  { name: `assets/${ns}/models/item/huge.json`, data: json({ textures: { layer0: `${ns}:item/huge` } }) },
  { name: `assets/${ns}/textures/item/huge.png`, data: crypto.randomBytes(600000) },
  { name: `assets/${ns}/models/item/notpng.json`, data: json({ textures: { layer0: `${ns}:item/notpng` } }) },
  { name: `assets/${ns}/textures/item/notpng.png`, data: Buffer.from('<svg onload="alert(1)"/>') },
];
let deep = { type: 'minecraft:model', model: 'minecraft:item/x' };
for (let i = 0; i < 40; i++) deep = { type: 'minecraft:composite', models: [deep] };
fs.writeFileSync(path.join(modsDir, 'good.jar'), writeZip([...modAssets('good'), { name: 'assets/good/items/deep.json', data: json({ model: deep }) }]));
fs.writeFileSync(path.join(modsDir, 'Upper.JAR'), writeZip([{ name: 'assets/upper/lang/en_us.json', data: json({ 'item.upper.thing': 'Thing' }) }, { name: 'assets/upper/models/item/thing.json', data: json({}) }]));
const HOSTILE_ENTRIES = ['assets/../../evil/lang/en_us.json', 'assets/../items/evil.json', 'assets/./items/evil.json', 'assets/ok/items/../../../evil.json', 'assets/ok/items/..json', 'assets/ok/items/.hidden.json', 'assets/ok/items/a:b.json', 'assets/ok/items/UP.json', 'assets/ok/items/a\\b.json', 'assets/ok/items/nul\u0000.json', 'assets/ok:stream/items/x.json', 'C:\\evil\\assets\\ok\\items\\x.json', '/assets/ok/items/rooted.json', 'assets/ok/models/item/../../../evil.json'];
fs.writeFileSync(path.join(modsDir, 'paths.jar'), writeZip([...HOSTILE_ENTRIES.map((name) => ({ name, data: json({ model: { type: 'minecraft:model', model: 'x' } }) })), { name: 'assets/ok/items/fine.json', data: json({ model: { type: 'minecraft:model', model: 'ok:item/fine' } }) }]));
fs.writeFileSync(path.join(modsDir, 'tricks.jar'), writeZip([
  { name: 'assets/minecraft/lang/en_us.json', data: json({ 'item.minecraft.diamond': 'Hacked' }) },
  { name: 'assets/minecraft/items/diamond.json', data: json({ model: { type: 'minecraft:model', model: 'x' } }) },
  { name: 'assets/tricks/lang/en_us.json', data: Buffer.from(`{"__proto__":{"polluted":"yes"},"constructor":"x","item.tricks.name":"Line\\nbreak\\u0000 <img src=x onerror=alert(1)> ${'y'.repeat(500)}","item.tricks.number":5,"item.tricks.nested":{"a":1}}`) },
  { name: 'assets/tricks/items/name.json', data: json({ model: { type: 'minecraft:model', model: 'tricks:item/name' } }) },
  { name: 'assets/tricks/items/number.json', data: json({ model: 5 }) },
  { name: 'assets/tricks/items/nested.json', data: Buffer.from('{broken') },
]));
fs.writeFileSync(path.join(modsDir, 'bigger.jar'), writeZip([{ name: 'assets/bulk/lang/en_us.json', data: json(Object.fromEntries(Array.from({ length: 450 }, (_v, i) => [`item.bulk.thing_${i}`, `Thing ${i}`]))) }, ...Array.from({ length: 450 }, (_v, i) => ({ name: `assets/bulk/items/thing_${i}.json`, data: json({ model: { type: 'minecraft:model', model: `bulk:item/thing_${i}` } }) }))]));
fs.writeFileSync(path.join(modsDir, 'notazip.jar'), 'this is not a zip file at all');
fs.writeFileSync(path.join(modsDir, 'empty.jar'), '');
fs.writeFileSync(path.join(modsDir, 'readme.txt'), 'not a jar');
fs.mkdirSync(path.join(modsDir, 'folder.jar'));
// Entries that share their data: the central directory's second entry points at the first.
const pair = writeZip([{ name: 'assets/overlap/items/a.json', data: json({}) }, { name: 'assets/overlap/items/b.json', data: json({}) }]);
const secondCentral = pair.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
pair.writeUInt32LE(0, secondCentral + 42);
fs.writeFileSync(path.join(modsDir, 'overlap.jar'), pair);
// A language file that says it is small and inflates to far more: read() stops at what it declared.
const liar = writeZip([{ name: 'assets/liar/lang/en_us.json', data: Buffer.alloc(8 * 1024 * 1024, 0x20) }, { name: 'assets/liar/items/x.json', data: json({ model: { type: 'minecraft:model', model: 'liar:item/x' } }) }]);
const liarCentral = liar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
liar.writeUInt32LE(16, liarCentral + 24);
fs.writeFileSync(path.join(modsDir, 'liar.jar'), liar);
// Every language file is within its limit, and together they pass what one jar may spend.
const greedy = ['a', 'b', 'c', 'd', 'e'].flatMap((ns) => [
  { name: `assets/greedy${ns}/lang/en_us.json`, data: Buffer.from(`{"item.greedy${ns}.x":"Named","pad":"${' '.repeat(15 * 1024 * 1024)}"}`) },
  { name: `assets/greedy${ns}/items/x.json`, data: json({ model: { type: 'minecraft:model', model: `greedy${ns}:item/x` } }) },
]);
fs.writeFileSync(path.join(modsDir, 'greedy.jar'), writeZip(greedy));
// Just over the limit, in a file that takes no time to make.
const tooLarge = path.join(modsDir, 'toolarge.jar');
fs.closeSync(fs.openSync(tooLarge, 'w'));
fs.truncateSync(tooLarge, 256 * 1024 * 1024 + 1);

const before = fs.readdirSync(work).sort().join();
const server1 = { dir: path.join(work, 'server'), version: '1.21.11', cacheDir: cache };
const all = await items.catalog(server1, '');
same(all.length, 200, 'a catalog stops at 200');
same(all.coverage.items, 16 + 8 + 1 + 1 + 3 + 450 + 1 + 5, 'the coverage counts all of it');
same(byId(await items.catalog(server1, 'greedya:')).get('greedya:x').name, 'Named', 'a jar reads what its budget allows');
same(byId(await items.catalog(server1, 'greedye:')).get('greedye:x').name, 'greedye:x', 'and no more');
const whole = byId(await items.catalog(server1, 'good:'));
same(whole.get('good:wrench').name, 'Wrench', 'a mod item\'s name');
same(whole.get('good:wrench').ko, '\ub80c\uce58', 'a mod item\'s Korean name');
same(whole.get('good:wrench').mod, 'good', 'and its mod');
same(unpng(whole.get('good:wrench').icon).pixel(0, 0)[0], 40, 'a mod item\'s icon');
same(unpng(whole.get('good:gear').icon).pixel(0, 0)[0], 41, 'a mod block\'s icon');
check(!whole.has('good:helper_template'), 'a model without a language name is no item');
for (const id of ['loop', 'deep', 'far', 'tall', 'huge', 'notpng']) {
  check(whole.has(`good:${id}`), `${id} is listed`);
  same(whole.get(`good:${id}`).icon, null, `${id} has a blank tile`);
}
same(unpng((await items.icons(server1, ['good:wrench']))['good:wrench'].icon).width, 16, 'icons look in mods');
same((await items.catalog({ ...server1, mods: [path.join(modsDir, 'good.jar')] }, 'bulk')).length, 0, 'mods can name jars');
same((await items.catalog({ ...server1, mods: path.join(modsDir, 'no-such') }, 'bulk')).length, 0, 'a missing mods folder is no mods');
same((await items.catalog({ ...server1, mods: [5, null, 'x.txt'] }, 'bulk')).length, 0, 'an odd mods list is harmless');
check(byId(await items.catalog(server1, 'upper:')).has('upper:thing'), 'a .JAR in capitals is read');

const paths = await items.catalog(server1, 'ok:');
same(paths.map((i) => i.id).join(), 'ok:fine', 'only a plain path is an item');
const named = byId(await items.catalog(server1, 'tricks:'));
same((await items.catalog(server1, 'Hacked')).length, 0, 'a mod does not rename the game\'s items');
same(byId(await items.catalog(server1, 'minecraft:diamond')).get('minecraft:diamond').name, 'Diamond', 'the game\'s name stays');
same({}.polluted, undefined, 'a language file pollutes nothing');
const hostile = named.get('tricks:name').name;
check(hostile.length <= 120 && !/[\p{Cc}]/u.test(hostile), `a mod's name is one short line: ${hostile.length}`);
same(named.get('tricks:number').name, 'tricks:number', 'a name that is no text falls back to the id');
same(named.get('tricks:nested').icon, null, 'a broken definition has a blank tile');

const skipped = all.skipped.join(' | ');
check(/toolarge\.jar is too large/.test(skipped), `a jar over the limit is skipped: ${skipped}`);
check(/notazip\.jar/.test(skipped) && /empty\.jar/.test(skipped), 'what is no zip is skipped with its name');
check(/overlap\.jar/.test(skipped), 'overlapping entries are refused');
same(all.reason, null, 'a skipped jar does not lose the game\'s items');
same(byId(await items.catalog(server1, 'liar:')).get('liar:x')?.name, 'liar:x', 'a lying entry is left unread');
same(await items.catalog(server1, 'liar:').then((l) => l.length), 1, 'and the jar still counts');
const modCache = pathsUnder(path.join(cache, 'mods'));
check(modCache.length > 0 && modCache.every((n) => /^[0-9a-f]{40}\.json$/.test(n)), `every mod cache file is named by a hash: ${modCache.slice(0, 3)}`);
same(fs.readdirSync(work).sort().join(), before, 'nothing appeared beside the cache');
check(pathsUnder(cache).every((n) => !/evil|secret/.test(n)), 'and nothing named by a jar appeared in it');

fs.rmSync(path.join(cache, 'mods'), { recursive: true });
items.reset();
hits.length = 0;
same((await items.catalog(server1, 'good:')).length, 8, 'mods are read again without their cache');
same(hits.length, 0, 'without the network');
const touched = path.join(modsDir, 'good.jar');
fs.writeFileSync(touched, writeZip([{ name: 'assets/good/items/newer.json', data: json({ model: { type: 'minecraft:model', model: 'good:item/newer' } }) }]));
same((await items.catalog(server1, 'good:')).map((i) => i.id).join(), 'good:newer', 'a changed jar is read again');

// A jar of many namespaces cost a pass over its entries per namespace: 8000 of them shut the event loop for 5 s.
const crowdedDir = path.join(work, 'crowded');
fs.mkdirSync(crowdedDir);
const crowdedJar = path.join(crowdedDir, 'crowded.jar');
fs.writeFileSync(crowdedJar, writeZip(Array.from({ length: 8000 }, (_v, i) => ({ name: `assets/ns${i}/items/thing.json`, data: json({ model: { type: 'minecraft:model', model: `ns${i}:item/thing` } }) }))));
const crowdedOpts = { dir: path.join(work, 'no-such-server'), version: '1.21.11', cacheDir: cache, mods: [crowdedJar] };
let lastTick = performance.now();
let longest = 0;
const ticking = setInterval(() => { const at = performance.now(); longest = Math.max(longest, at - lastTick); lastTick = at; }, 1);
const crowded = await items.catalog(crowdedOpts, 'thing');
clearInterval(ticking);
check(crowded.skipped.some((s) => /first 256 of the 8000 namespaces of crowded\.jar/.test(s)), `the namespaces past the cap are reported: ${crowded.skipped}`);
same(crowded.coverage.items - 16, 256, 'and those within it are read');
check(longest < 1000, `the event loop keeps running through a crowded jar: longest stall ${longest | 0} ms`);
console.log(`crowded jar: longest stall of the event loop ${longest | 0} ms`);

// ---- items: no network

await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
items.reset();
const noServer = { dir: path.join(work, 'server'), version: '1.21.1', cacheDir: path.join(work, 'cache-empty') };
const offline = await items.catalog(noServer, 'upper');
same(offline.map((i) => i.id).join(), 'upper:thing', 'offline with no cache still lists mod items');
same(offline.reasonCode, 'download', 'and says why the game\'s are missing');
check(!!offline.reason, `the reason: ${offline.reason}`);
same((await items.catalog(noServer, 'Hacked')).length, 0, 'a mod\'s minecraft/ files do not stand in for the game\'s items');
const offlineBare = await items.catalog({ ...noServer, dir: path.join(work, 'none'), mods: [] }, '');
check(offlineBare.length === 0 && !!offlineBare.reason, 'offline with no mods is an empty list with a reason');
const offlineNames = await items.names(noServer);
check(offlineNames.enchantments.some((e) => e.id === 'minecraft:bane_of_arthropods' && e.name === 'Bane Of Arthropods' && e.ko === null), 'offline, the known ids are named after themselves');
check(offlineNames.effects.some((e) => e.id === 'minecraft:instant_health' && e.name === 'Instant Health' && e.ko === null), 'effects too');
same(offlineNames.reasonCode, 'download', 'and it says why');
check(!!offlineNames.reason, `the reason: ${offlineNames.reason}`);
same((await items.names({ version: '1.12.2', cacheDir: path.join(work, 'cache-empty') })).reasonCode, 'version', 'a version with no lookup has its code');
check((await items.names(null)).enchantments.length > 0, 'names without options do not throw');
items.reset();
const cached = await items.catalog({ version: '1.21.11', cacheDir: cache, mods: [] }, '');
same(cached.length, 16, 'offline with a cache is the whole catalog');
same(cached.reason, null, 'with no reason');

// ---------- moveItem: the lines of one move, against the game's rules in minecraft-players-game.cjs ----------
{
  const { checkMove, buildMove, moveDiff, sameStacks, changedSlots } = require('../main/minecraft/players/actions.js');
  const { createGame } = require('./minecraft-players-game.cjs');
  const { parseSnbt, detailOf, slotIn } = require('../main/minecraft/players/nbt.js');
  const PRINT_A = 'a'.repeat(40);
  const NAMES = { 0: 'hotbar.0', 8: 'hotbar.8', 9: 'inventory.0', 35: 'inventory.26', 100: 'armor.feet', 101: 'armor.legs', 102: 'armor.chest', 103: 'armor.head', [-106]: 'weapon.offhand', 200: 'enderchest.0', 226: 'enderchest.26' };
  for (const [slot, want] of Object.entries(NAMES)) same(line({ type: 'replaceSlot', target: 'Steve', slot: Number(slot), item: 'minecraft:air' }), `item replace entity Steve ${want} with minecraft:air 1`, `slot ${slot}`);
  refused({ type: 'replaceSlot', target: 'Steve', slot: 227, item: 'minecraft:air' }, 'slot', 'one past the ender chest');
  refused({ type: 'replaceSlot', target: 'Steve', slot: 36, item: 'minecraft:air' }, 'slot', 'one past the inventory');

  const move = (a, version = '26.3', kind = 'paper') => {
    try { return checkMove({ type: 'moveItem', target: 'Steve', ...a }, { version, kind }); } catch (err) { return err.expected ? { code: err.code } : { unexpected: err }; }
  };
  same(move({ op: 'move', from: 0, to: 1, shown: { from: PRINT_A, to: null } }).from, 0, 'a move is accepted');
  for (const [what, a, code, version, kind] of [
    ['an unknown way', { op: 'dupe', from: 0, to: 1 }, 'action'], ['no way at all', {}, 'action'], ['a slot that is no number', { op: 'move', from: 'hotbar.0', to: 1, shown: { from: PRINT_A } }, 'slot'],
    ['a line break in a slot', { op: 'move', from: 0, to: '1\nop Griefer', shown: { from: PRINT_A } }, 'slot'], ['the same slot', { op: 'move', from: 3, to: 3, shown: { from: PRINT_A, to: PRINT_A } }, 'sameSlot'],
    ['an empty source', { op: 'move', from: 3, to: 4, shown: { from: null, to: null } }, 'emptySlot'], ['nothing said about a slot', { op: 'clear', from: 3 }, 'emptySlot'],
    ['a print that is no print', { op: 'clear', from: 3, shown: { from: 'x' } }, 'shown'], ['a bad target', { op: 'clear', target: 'a b', from: 3, shown: { from: PRINT_A } }, 'name'],
    ['air placed', { op: 'place', to: 1, item: 'minecraft:air', shown: { to: null } }, 'item'], ['a bad item', { op: 'place', to: 1, item: 'x y', shown: { to: null } }, 'item'], ['too many', { op: 'place', to: 1, item: 'minecraft:stone', count: 65, shown: { to: null } }, 'count'],
    ['a sword as a chestplate', { op: 'place', to: 102, item: 'minecraft:diamond_sword', shown: { to: null } }, 'armorFit'], ['a version before item replace', { op: 'clear', from: 1, shown: { from: PRINT_A } }, 'version', '1.16.5'], ['a proxy', { op: 'clear', from: 1, shown: { from: PRINT_A } }, 'proxy', '3.4.0', 'velocity'],
  ]) same(move(a, version, kind).code, code, what);

  const plan = (game, name, a) => {
    const d = detailOf(parseSnbt(game.data()), { source: 'live' });
    const at = (s) => slotIn(d, s);
    const shown = { from: a.from === undefined ? undefined : at(a.from)?.print ?? null, to: a.to === undefined ? undefined : at(a.to)?.print ?? null };
    const p = checkMove({ type: 'moveItem', target: name, ...a, shown }, { version: game.version, kind: 'paper' });
    return { ...buildMove(p, { version: game.version }, at), at };
  };
  const play = (game, name, a) => {
    const { commands, expects, wanted } = plan(game, name, a);
    const answers = commands.slice(0, -1).flatMap((c) => game.run(c)).filter((t) => expects.ok.test(t) || expects.refused.test(t));
    const after = detailOf(parseSnbt(game.data()), { source: 'live' });
    return { commands, wrong: moveDiff(wanted, (s) => slotIn(after, s)), answers, ok: answers.every((t) => expects.ok.test(t)), refused: answers.some((t) => expects.refused.test(t)) };
  };
  const newGame = (version, stacks) => Object.assign(createGame({ version, name: 'Steve', stacks }), { version });
  const SWORD = { id: 'minecraft:diamond_sword', count: 1, extra: 'components: {"minecraft:damage": 12}' };
  const PLATE = { id: 'minecraft:iron_chestplate', count: 1 };
  const DIRT = { id: 'minecraft:dirt', count: 32 };

  let game = newGame('26.3', { 0: SWORD, 9: DIRT });
  let r = play(game, 'Steve', { op: 'move', from: 0, to: 1 });
  same(r.commands.length, 6, 'a move is a fresh record, three steps, the record removed and a read');
  same(r.commands[0], 'data modify storage nano:move ok set value {}', 'the record starts empty');
  same(r.commands[1], 'execute if data entity Steve Inventory[{Slot:0b,id:"minecraft:diamond_sword",count:1}] unless data entity Steve Inventory[{Slot:1b}] store success storage nano:move ok.copied byte 1 run item replace entity Steve hotbar.1 from entity Steve hotbar.0', 'the copy is guarded and records its success');
  same(r.commands[2], 'execute if data storage nano:move {ok:{copied:1b}} if data entity Steve Inventory[{Slot:0b,id:"minecraft:diamond_sword",count:1}] store success storage nano:move ok.wiped byte 1 run item replace entity Steve hotbar.0 with minecraft:air', 'the clear starts from the copy\'s success');
  same(r.commands[4], 'data remove storage nano:move ok', 'the record is removed');
  same(r.commands[5], 'data get entity Steve', 'and the read comes last');
  same(JSON.stringify(game.storage), '{}', 'nothing is left in the storage');
  check(r.wrong.length === 0 && r.ok && game.held.get(1).extra === SWORD.extra && !game.held.has(0), 'the stack moved with its data');
  same(r.answers[0], 'Replaced 1 slot(s) on Steve with [Diamond Sword]', 'the answer of 26.3');

  game = newGame('1.20.1', { 0: { ...SWORD, extra: 'tag: {Damage: 12}' }, 103: { id: 'minecraft:iron_helmet', count: 1 }, 200: DIRT });
  r = play(game, 'Steve', { op: 'move', from: 103, to: 5 });
  check(r.commands[1].includes('Inventory[{Slot:103b,id:"minecraft:iron_helmet",Count:1b}]') && r.wrong.length === 0 && r.ok, 'armor is in Inventory on 1.20.1');
  same(r.answers[1], 'Replaced a slot on Steve with [Air]', 'the answer of 1.20.1');
  r = play(game, 'Steve', { op: 'move', from: 200, to: 201 });
  check(r.commands[1].includes('EnderItems[{Slot:0b,id:"minecraft:dirt",Count:32b}]') && r.commands[1].includes('enderchest.1 from entity Steve enderchest.0') && r.wrong.length === 0, 'within the ender chest');

  game = newGame('26.3', { 102: PLATE, 200: DIRT, [-106]: { id: 'minecraft:torch', count: 12 } });
  r = play(game, 'Steve', { op: 'move', from: 102, to: 3 });
  check(r.commands[1].includes('equipment.chest{id:"minecraft:iron_chestplate",count:1}') && r.commands[3].includes('Inventory[{Slot:3b') && r.wrong.length === 0, 'armor is in equipment on 26.3');
  r = play(game, 'Steve', { op: 'move', from: -106, to: 200 });
  check(r.commands[1].includes('equipment.offhand{id:"minecraft:torch",count:12}') && r.wrong.length === 0 && game.held.get(-106).id === 'minecraft:dirt', 'the offhand swaps with the ender chest');

  game = newGame('26.3', { 0: SWORD, 1: DIRT });
  const before = game.all();
  r = play(game, 'Steve', { op: 'move', from: 0, to: 1 });
  same(r.commands.length, 9, 'a swap is a fresh record, six steps, the record removed and a read');
  check(r.commands[1].includes('inventory.26 from entity Steve hotbar.1'), 'through the last slot of the main inventory');
  check(r.wrong.length === 0 && game.held.get(1).id === SWORD.id && game.held.get(0).id === DIRT.id && !game.held.has(35), 'swapped, and the temporary slot is empty again');
  same(game.all(), before, 'nothing was lost or doubled');

  const full = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [i, { id: 'minecraft:dirt', count: i + 1 }]));
  game = newGame('26.3', full);
  try { play(game, 'Steve', { op: 'move', from: 0, to: 1 }); check(false, 'a full inventory cannot swap'); } catch (err) { same(err.code, 'noRoom', 'a full inventory cannot swap'); }

  game = newGame('26.3', { 0: SWORD, 102: PLATE });
  try { play(game, 'Steve', { op: 'move', from: 0, to: 102 }); check(false, 'a sword is no chestplate'); } catch (err) { same(err.code, 'armorFit', 'a sword is no chestplate'); }
  game = newGame('26.3', { 0: { id: 'minecraft:diamond_chestplate', count: 1 }, 102: PLATE });
  r = play(game, 'Steve', { op: 'move', from: 0, to: 102 });
  check(r.commands[2].includes('armor.chest from entity Steve hotbar.0') && r.wrong.length === 0, 'a swap writes the armor slot first');

  game = newGame('26.3', { 0: { id: 'somemod:robe_chestplate', count: 1 } });
  const refusing = createGame({ version: '26.3', name: 'Steve', stacks: { 0: { id: 'somemod:robe_chestplate', count: 1 } } });
  refusing.refuses = () => true;
  const said = plan(game, 'Steve', { op: 'move', from: 0, to: 102 }).commands.slice(0, -1).flatMap((l) => refusing.run(l)).filter((l) => !l.startsWith('Modified'));
  check(said.length === 1 && refusing.held.has(0) && !refusing.held.has(102), 'a copy the game refuses leaves the source alone: the clear does not run');
  const plain = createGame({ version: '26.3', name: 'Steve', stacks: { 0: { id: 'minecraft:stick', count: 1 } } });
  plain.run('item replace entity Steve armor.chest from entity Steve hotbar.0');
  plain.run('item replace entity Steve hotbar.0 with minecraft:air');
  same(plain.held.size, 0, 'control: without the guard the same refusal deletes the item');

  game = newGame('26.3', { 0: SWORD });
  r = play(game, 'Steve', { op: 'clear', from: 0 });
  check(r.commands.length === 2 && game.held.size === 0 && r.wrong.length === 0, 'clear is one guarded line and a read');
  r = play(game, 'Steve', { op: 'place', to: 4, item: 'minecraft:stone', count: 16 });
  check(r.commands[0].startsWith('execute unless data entity Steve Inventory[{Slot:4b}] run item replace entity Steve hotbar.4 with minecraft:stone 16') && game.held.get(4).count === 16 && r.wrong.length === 0, 'place on an empty slot');
  r = play(game, 'Steve', { op: 'place', to: 4, item: 'minecraft:dirt', count: 2 });
  check(r.commands[0].startsWith('execute if data entity Steve Inventory[{Slot: 4b, id: "minecraft:stone", count: 16}] run ') && game.held.get(4).id === 'minecraft:dirt', 'place on a filled slot tests the whole stack');
  same(moveDiff([[4, { id: 'minecraft:dirt', count: 3 }]], (s) => (s === 4 ? { id: 'minecraft:dirt', count: 2 } : null)).length, 1, 'a count that differs is a difference');

  // Steps against what can happen between them, one line at a time: `each(n, game, line)` runs just before line n.
  const lines = (g, a) => plan(g, 'Steve', a).commands.slice(0, -1);
  const stepped = (g, a, each) => { lines(g, a).forEach((c, n) => { each(n, g, c); g.run(c); }); };
  const lineWith = (g, a, text) => lines(g, a).findIndex((c) => c.endsWith(text));
  const SHULKER = { id: 'minecraft:shulker_box', count: 1, extra: 'components: {"minecraft:custom_name": "A"}' };
  const OTHER = { id: 'minecraft:shulker_box', count: 1, extra: 'components: {"minecraft:custom_name": "B"}' };
  const COBBLE = { id: 'minecraft:cobblestone', count: 12 };

  for (const version of ['26.3', '1.20.1']) {
    const sword = version === '26.3' ? SWORD : { ...SWORD, extra: 'tag: {Damage: 12}' };
    const twin = version === '26.3' ? { ...SWORD, extra: 'components: {"minecraft:damage": 99}' } : { ...SWORD, extra: 'tag: {Damage: 99}' };
    const swap01 = { op: 'move', from: 0, to: 1 };

    game = newGame(version, { 0: sword });
    stepped(game, { op: 'move', from: 0, to: 1 }, (n, g) => { if (n === 0) g.held.set(1, twin); });
    check(game.held.get(0)?.extra === sword.extra && game.held.get(1)?.extra === twin.extra, `${version}: a look-alike that lands in the target after the read refuses the copy, and the source is not wiped`);
    same(JSON.stringify(game.storage), '{}', `${version}: and the record is gone`);

    game = newGame(version, { 0: SHULKER, 1: OTHER });
    stepped(game, swap01, (n, g) => { if (n === 0) g.held.set(35, COBBLE); });
    check(game.held.get(0)?.extra === SHULKER.extra && game.held.get(1)?.extra === OTHER.extra && game.held.get(35)?.id === COBBLE.id && game.held.size === 3, `${version}: a pickup that fills the temporary slot stops a swap of two look-alikes with nothing overwritten or doubled`);

    game = newGame(version, { 0: sword, 1: DIRT });
    let at = lineWith(game, swap01, 'hotbar.1 from entity Steve hotbar.0');
    stepped(game, swap01, (n, g) => { if (n === at) g.swap(1, 7); });
    check(game.held.get(0)?.extra === sword.extra && game.held.get(7)?.id === DIRT.id && !game.held.has(35) && game.stacks().length === 2, `${version}: the target moved after the first copy: it is not written, and the spare copy in temp goes`);

    game = newGame(version, { 0: sword, 1: DIRT });
    at = lineWith(game, swap01, 'hotbar.0 from entity Steve inventory.26');
    stepped(game, swap01, (n, g) => { if (n === at) g.swap(1, 7); });
    check(game.held.get(0)?.id === DIRT.id && game.held.get(7)?.extra === sword.extra && !game.held.has(35) && game.stacks().length === 2, `${version}: the target moved between the second and third writes: the source is still free to take the dirt, and temp is freed`);

    game = newGame(version, { 0: sword, 1: DIRT });
    stepped(game, swap01, (n, g) => { if (n === at) { g.swap(0, 7); g.swap(1, 8); } });
    check(game.held.get(35)?.id === DIRT.id, `${version}: both slots moved between the second and third writes: temp holds the only dirt and is not wiped`);
    same(JSON.stringify(game.storage), '{}', `${version}: and the record is gone`);
    check(!!slotIn(detailOf(parseSnbt(game.data()), { source: 'live' }), 35), `${version}: and the read shows it there, so it cannot stay unnoticed`);

    game = newGame(version, { 0: sword, 1: DIRT });
    at = lineWith(game, swap01, 'hotbar.0 from entity Steve inventory.26');
    stepped(game, swap01, (n, g) => { if (n === at) g.swap(0, 7); });
    check(game.held.get(1)?.id === DIRT.id && game.held.get(7)?.extra === sword.extra && !game.held.has(0) && !game.held.has(35) && game.stacks().length === 2, `${version}: the source moved between the second and third writes: the dirt goes back, temp is freed, nothing is doubled`);

    game = newGame(version, { 0: sword, 1: DIRT });
    const plain = game.stacks().join();
    game.refuses = (slot, stack) => slot === 0 && stack.id === DIRT.id;
    stepped(game, swap01, () => {});
    check(game.held.get(0)?.extra === sword.extra && game.held.get(1)?.id === DIRT.id && !game.held.has(35) && game.stacks().join() === plain, `${version}: a third write the game refuses puts everything back and frees temp`);

    game = newGame(version, { 0: sword, 1: DIRT });
    game.refuses = (slot) => slot === 1;
    stepped(game, swap01, () => {});
    check(game.held.get(0)?.extra === sword.extra && game.held.get(1)?.id === DIRT.id && !game.held.has(35), `${version}: a second write the game refuses frees temp`);

    game = newGame(version, { 0: sword });
    at = lineWith(game, { op: 'move', from: 0, to: 1 }, 'store success storage nano:move ok.wiped byte 1 run item replace entity Steve hotbar.0 with minecraft:air');
    stepped(game, { op: 'move', from: 0, to: 1 }, (n, g) => { if (n === at) g.swap(0, 7); });
    check(!game.held.has(1) && game.held.get(7)?.extra === sword.extra && game.stacks().length === 1, `${version}: the source moved after the copy: the copy goes, and the stack is not doubled`);

    game = newGame(version, { 0: sword });
    stepped(game, { op: 'clear', from: 0 }, (n, g) => { if (n === 0) g.held.set(0, twin); });
    check(game.held.get(0)?.extra === twin.extra, `${version}: a clear leaves a look-alike that took the slot after the read`);
    game = newGame(version, { 4: sword });
    stepped(game, { op: 'place', to: 4, item: 'minecraft:stone', count: 3 }, (n, g) => { if (n === 0) g.held.set(4, twin); });
    check(game.held.get(4)?.extra === twin.extra, `${version}: a place leaves a look-alike that took the slot after the read`);
  }
  game = newGame('26.3', { 102: PLATE });
  same(plan(game, 'Steve', { op: 'clear', from: 102 }).commands[0], 'execute if data entity Steve equipment.chest{id: "minecraft:iron_chestplate", count: 1} run item replace entity Steve armor.chest with minecraft:air', 'a clear of armor tests the whole stack where armor lies');
  game = newGame('26.3', { 200: { ...DIRT, extra: 'components: {"minecraft:custom_name": "a b"}' } });
  r = play(game, 'Steve', { op: 'clear', from: 200 });
  check(game.held.size === 0 && r.wrong.length === 0, 'a clear in the ender chest, with a space in the stack\'s text');
  game = newGame('1.20.1', { 0: { ...SWORD, extra: 'tag: {pages: ["one\ntwo"]}' } });
  const broken = plan(game, 'Steve', { op: 'clear', from: 0 }).commands;
  same(broken[0], 'execute if data entity Steve Inventory[{Slot:0b,id:"minecraft:diamond_sword",Count:1b}] run item replace entity Steve hotbar.0 with minecraft:air', 'a raw line break cannot go on a console line, so that stack keeps its id and count');
  check(broken.every((c) => !/[\r\n]/.test(c)), 'and every line is one line');

  game = newGame('26.3', { 0: SWORD, 201: DIRT });
  const was = detailOf(parseSnbt(game.data()), { source: 'live' });
  game.held.delete(0);
  game.held.set(1, { ...DIRT, count: 1 });
  game.held.set(201, { ...DIRT, count: 31 });
  const changed = changedSlots(was, detailOf(parseSnbt(game.data()), { source: 'live' }));
  same(changed.map((c) => c.slot).sort((a, b) => a - b).join(), '0,1,201', 'every slot that differs is listed, the ender chest by its number');
  same(changed.find((c) => c.slot === 0).before, '{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:damage": 12}}', 'a lost stack keeps the game\'s own print, number types included');
  same(changed.find((c) => c.slot === 0).after, null, 'and the slot reads empty after');
  same(changed.find((c) => c.slot === 201).name, 'enderchest.1', 'with the name a command uses');

  // A player's click against a move. The ticks between the read and the lines are the real exposure: `before`. Console
  // lines drain together at one point of a tick, so `between` needs a line to reach the queue after the drain, and it runs
  // on every move here: a worst case, not a rate. `twins` makes every stack different in its data, so that a guard on id and
  // count cannot tell two apart. The numbers are printed rather than hidden: anything lost or doubled must at least show
  // in the read afterwards.
  const rng = (() => { let x = 88172645; return (n) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return Math.abs(x) % n; }; })();
  const POOL = ['minecraft:dirt', 'minecraft:stone', 'minecraft:iron_chestplate', 'minecraft:diamond_sword', 'minecraft:torch'];
  const SLOTS = [0, 1, 2, 3, 9, 10, 34, 35, 100, 101, 102, 103, -106, 200, 201];
  const tallyOf = (list) => list.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map());
  const race = (moment, twins) => {
    const tally = { runs: 0, kept: 0, lost: 0, doubled: 0, shown: 0, unseen: 0 };
    let mark = 0;
    for (let i = 0; i < 20000; i++) {
      const stacks = {};
      for (const s of SLOTS) if (rng(2) && s !== 100 && s !== 101 && s !== 102) stacks[s] = { id: POOL[rng(POOL.length)], count: 1 + rng(4), ...(twins && { extra: `components: {n: ${++mark}}` }) };
      const g = newGame(rng(2) ? '26.3' : '1.20.1', stacks);
      const filled = [...g.held.keys()];
      if (!filled.length) continue;
      const from = filled[rng(filled.length)];
      const to = SLOTS[rng(SLOTS.length)];
      if (to === from) continue;
      let built;
      const start = detailOf(parseSnbt(g.data()), { source: 'live' });
      const a = { op: 'move', from, to };
      try { built = plan(g, 'Steve', a); } catch (err) { if (err.expected) continue; throw err; }
      const whole = g.stacks();
      const list = built.commands.slice(0, -1);
      const steps = list.flatMap((c, n) => (c.startsWith('execute') ? [n] : []));
      const click = moment === 'before' ? 0 : steps[1 + rng(steps.length - 1)];
      list.forEach((c, n) => {
        if (n === click) g.swap(SLOTS[rng(SLOTS.length)], SLOTS[rng(SLOTS.length)]);
        g.run(c);
      });
      tally.runs++;
      const [then, now] = [tallyOf(whole), tallyOf(g.stacks())];
      const lost = [...then].some(([s, n]) => (now.get(s) ?? 0) < n);
      const doubled = [...now].some(([s, n]) => (then.get(s) ?? 0) < n);
      if (!lost && !doubled) { tally.kept++; continue; }
      if (lost) tally.lost++;
      if (doubled) tally.doubled++;
      const after = detailOf(parseSnbt(g.data()), { source: 'live' });
      if (moveDiff(built.wanted, (s) => slotIn(after, s)).length || !sameStacks(a, start, after)) tally.shown++;
      else tally.unseen++;
    }
    return tally;
  };
  for (const [moment, twins, words] of [['before', false, 'a click before the lines'], ['before', true, 'a click before the lines, every stack different'], ['between', false, 'a click between the lines'], ['between', true, 'a click between the lines, every stack different']]) {
    const t = race(moment, twins);
    console.log(`${words}: ${JSON.stringify(t)}`);
    check(t.runs > 10000, `${words}: that race ran`);
    same(t.unseen, 0, `${words}: a loss never goes unseen`);
    if (moment === 'before') same(t.lost + t.doubled, 0, `${words}: nothing is lost or doubled`);
  }
  const clicks = (g, a) => { const start = detailOf(parseSnbt(g.data()), { source: 'live' }); const { commands } = plan(g, 'Steve', a); commands.slice(0, -1).forEach((c) => g.run(c)); return sameStacks(a, start, detailOf(parseSnbt(g.data()), { source: 'live' })); };
  check(clicks(newGame('26.3', { 0: SWORD, 1: DIRT }), { op: 'move', from: 0, to: 1 }), 'a swap keeps the stacks');
  check(clicks(newGame('26.3', { 0: SWORD }), { op: 'clear', from: 0 }), 'a clear leaves the one stack less it should');
  check(clicks(newGame('26.3', { 0: SWORD, 4: DIRT }), { op: 'place', to: 4, item: 'minecraft:stone', count: 3 }), 'a place swaps one stack for the new one');

}

const blank = coverage.blank;
console.log(`stand-in coverage: ${coverage.icons} of ${coverage.items} items have an icon, ${blank} are blank tiles (a head with no model texture, a missing texture, a strip that is not a multiple)`);
fs.rmSync(work, { recursive: true, force: true });
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
