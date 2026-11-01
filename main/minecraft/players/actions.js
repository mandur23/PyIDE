// A player action -> the console lines that do it, for a server's game version. Pure: nothing here runs a command.
// build() throws an error with {expected: true, code} for anything it will not write, because a form it is not sure of
// must not reach a console.
//
// Forms as checked on minecraft.wiki, against 26.3:
//   give, clear           Commands/give, Commands/clear; {tag} NBT and [components]: Java Edition 1.20.5
//   Enchantments, lvl     Item format/Before 1.20.5 (1.13 snapshot 18w21a named it Enchantments), NBT format (the s suffix)
//   enchantments={levels:{...}} and the flat form    Data component format history, Java Edition 1.21.5 (25w04a)
//   stored_enchantments   Data component format history
//   item replace entity   Commands/item, Java Edition 21w19a; slot names: Slot. `from entity` and the slot names hotbar.N,
//                         inventory.N, enderchest.N, armor.*, weapon.offhand also read from ItemCommands and SlotArgument
//                         (1.20.1), ItemCommands and SlotRanges (26.3) in real jars
//   execute if data       Commands/execute; data, entity, if, unless and run in ExecuteCommand of the same jars
//   execute store success storage ... byte 1, data modify storage, data remove storage, a path that is only {...}
//                         ExecuteCommand (wrapStores), DataCommands and NbtPathArgument of the same jars, through javap
//   effect                Commands/effect (infinite: 1.19.4; instant effects count ticks, not seconds)
//   tp                    Commands/tp (the coordinate limits are 1.16's)
//   gamemode              Commands/gamemode (full names since 1.3.1, spectator since 1.8)
//   msg, kick, ban        Commands/msg, kick, ban (selectors in a message are resolved)
//   pardon, op, deop, whitelist    Commands/pardon, op, deop, whitelist
// Not confirmed, so refused: /replaceitem of 1.13 to 1.16 (Commands/replaceitem shows only Bedrock's form), everything
// about items, effects and tp before 1.13, and item data on any version newer than CHECKED_THROUGH. Item data is the one
// form that has changed between versions, so a new release stops only that. The other forms have not changed since their
// floor, and a release that breaks one gets the server's own refusal back.
const CHECKED_THROUGH = '26.3';

const NAME = /^[A-Za-z0-9_.]{1,16}$/;
const RESOURCE = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
const RELEASE = /^\d+(\.\d+)+$/;
const MODES = ['survival', 'creative', 'adventure', 'spectator'];
// 100 stacks of 64, what /give hands out at most since 1.17.
const MAX_GIVE = 6400;
// Commands/item allows 99 today. 64 fits every version it exists in.
const MAX_SLOT = 64;
const MAX_ENCHANTMENTS = 64;
// The chat box's limit. The wiki states none for a message.
const MAX_TEXT = 256;
const LINE_BREAKS = /[\p{Cc}\u2028\u2029]+/gu;
// 2 HP x 2^level: level 11 covers the 1024 HP the max_health attribute stops at. Level 30 and up overflow to nothing.
const HEAL_AMPLIFIER = 10;
// One food point per level per tick, and the bar holds 20.
const FEED_AMPLIFIER = 19;

const { slotIn, printOfStack } = require('./nbt');

const refuse = (code, message) => Object.assign(new Error(message), { expected: true, code });

const parts = (version) => version.split('.').map(Number);
function atLeast(version, floor) {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

function name(value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw refuse('name', 'That is not a player name');
  return value;
}
function resource(value, what) {
  if (typeof value !== 'string' || value.length > 128 || !RESOURCE.test(value)) throw refuse(what, `That is not a valid ${what} id`);
  return value.includes(':') ? value : `minecraft:${value}`;
}
function whole(value, min, max, what) {
  if (!Number.isInteger(value) || value < min || value > max) throw refuse(what, `The ${what} must be a whole number from ${min} to ${max}`);
  return value;
}
// A message argument runs to the end of the line, so quotes and spaces are harmless in it. A line break would start the
// next command, and the game resolves @a in a message into the names it selects, so a whisper could read out the
// players and entities on the server.
function text(value, what) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refuse('text', `The ${what} must be text`);
  const line = value.replace(LINE_BREAKS, ' ').replace(/@/g, '\uff20').trim();
  if (line.length > MAX_TEXT) throw refuse('text', `The ${what} is longer than ${MAX_TEXT} characters`);
  return line;
}
function coordinate(value, limit) {
  const plain = typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));
  const n = plain ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < -limit || n >= limit) throw refuse('coordinates', `A coordinate must be a number from -${limit} up to ${limit}`);
  // toFixed keeps 1e-7 out of the line, which the command's number parser does not read.
  return String(Number(n.toFixed(3)));
}

function enchantmentList(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_ENCHANTMENTS) throw refuse('enchantment', 'That is not a list of enchantments');
  const levels = new Map();
  for (const e of list) levels.set(resource(e?.id, 'enchantment'), whole(e?.level, 1, 255, 'enchantment level'));
  return [...levels];
}
// Enchantments on an enchanted book do nothing: a book keeps them as stored ones, in every format.
function stack({ item, enchantments }, version) {
  const id = resource(item, 'item');
  const list = enchantmentList(enchantments);
  if (!list.length) return id;
  if (!atLeast(CHECKED_THROUGH, version)) throw refuse('version', `Nano Studio has checked the form of enchantments up to Minecraft ${CHECKED_THROUGH}, and this server runs ${version}. The item can still be given without them.`);
  const book = id === 'minecraft:enchanted_book';
  if (!atLeast(version, '1.20.5')) {
    return `${id}{${book ? 'StoredEnchantments' : 'Enchantments'}:[${list.map(([e, level]) => `{id:"${e}",lvl:${level}s}`).join(',')}]}`;
  }
  const levels = `{${list.map(([e, level]) => `"${e}":${level}`).join(',')}}`;
  return `${id}[${book ? 'stored_enchantments' : 'enchantments'}=${atLeast(version, '1.21.5') ? levels : `{levels:${levels}}`}]`;
}
const SLOTS = new Map([[100, 'armor.feet'], [101, 'armor.legs'], [102, 'armor.chest'], [103, 'armor.head'], [-106, 'weapon.offhand']]);
const ENDER = 200;
function slotName(slot) {
  if (Number.isInteger(slot) && slot >= 0 && slot <= 8) return `hotbar.${slot}`;
  if (Number.isInteger(slot) && slot >= 9 && slot <= 35) return `inventory.${slot - 9}`;
  if (Number.isInteger(slot) && slot >= ENDER && slot < ENDER + 27) return `enderchest.${slot - ENDER}`;
  if (SLOTS.has(slot)) return SLOTS.get(slot);
  throw refuse('slot', 'That is not an inventory slot');
}
const withReason = (command, a) => {
  const reason = text(a.reason, 'reason');
  return `${command} ${name(a.target)}${reason ? ` ${reason}` : ''}`;
};
function teleport(a) {
  if (a.to !== undefined) return `tp ${name(a.target)} ${name(a.to)}`;
  return `tp ${name(a.target)} ${coordinate(a.x, 30000000)} ${coordinate(a.y, 20000000)} ${coordinate(a.z, 30000000)}`;
}
function effect(a, version) {
  if (a.clear === true) return `effect clear ${name(a.target)}${a.effect === undefined ? '' : ` ${resource(a.effect, 'effect')}`}`;
  const forever = a.seconds === 'infinite';
  if (forever && !atLeast(version, '1.19.4')) throw refuse('version', `An endless effect needs Minecraft 1.19.4 or newer, and this server runs ${version}`);
  const seconds = forever ? 'infinite' : whole(a.seconds ?? 30, 1, 1000000, 'duration');
  return `effect give ${name(a.target)} ${resource(a.effect, 'effect')} ${seconds} ${whole(a.amplifier ?? 0, 0, 255, 'amplifier')} ${a.hideParticles === true}`;
}

// The console's answers, from en_us.json of 1.20.1 and 26.3 (commands.*, argument.*, command.*, clear.failed.*). The
// wordings the two differ in are the op refusal and the unknown command line, and the patterns take both. An answer of
// neither shape is no answer, which reports as sent and unanswered.
const ANY_REFUSAL = String.raw`Unknown |Incorrect argument for command|Expected |Invalid |No (?:player|entity) was found|That player does not exist|Only (?:one (?:player|entity) is allowed|players may be affected)|Player not found|Can't find |Malformed |An unexpected error occurred|Item component '|Could not |Cannot |Nothing changed|.*<--\[HERE\]$`;
const EFFECT_GIVEN = (n) => [`Applied effect .+ to ${n}`, 'Unable to apply this effect'];

// type -> [oldest version whose form is confirmed, or null when it never changed; the action's line; (target as a
// pattern, action) -> [what success looks like, what its own refusal looks like]]
const ACTIONS = {
  give: ['1.13', (a, v) => `give ${name(a.target)} ${stack(a, v)} ${whole(a.count ?? 1, 1, MAX_GIVE, 'count')}`,
    (n) => [`Gave \\d+ .+ to ${n}`, "Can't give more than "]],
  clear: ['1.13', (a) => {
    if (a.item === undefined) return `clear ${name(a.target)}`;
    const line = `clear ${name(a.target)} ${resource(a.item, 'item')}`;
    return a.count === undefined ? line : `${line} ${whole(a.count, 1, 2147483647, 'count')}`;
  }, (n) => [`Removed \\d+ item\\(s\\) from player ${n}`, `No items were found on player ${n}`]],
  replaceSlot: ['1.17', (a, v) => `item replace entity ${name(a.target)} ${slotName(a.slot)} with ${stack(a, v)} ${whole(a.count ?? 1, 1, MAX_SLOT, 'count')}`,
    (n) => [`Replaced (?:a slot|\\d+ slot\\(s\\)) on ${n}(?: with .+)?`, 'No targets accepted item|The target does not have ']],
  teleport: ['1.13', teleport, (n) => [`Teleported ${n} to .+`]],
  gamemode: ['1.8', (a) => {
    if (!MODES.includes(a.mode)) throw refuse('gamemode', 'That is not a game mode');
    return `gamemode ${a.mode} ${name(a.target)}`;
  }, (n) => [`Set ${n}'s game mode to .+`]],
  heal: ['1.13', (a) => `effect give ${name(a.target)} minecraft:instant_health 1 ${HEAL_AMPLIFIER} true`, EFFECT_GIVEN],
  feed: ['1.13', (a) => `effect give ${name(a.target)} minecraft:saturation 1 ${FEED_AMPLIFIER} true`, EFFECT_GIVEN],
  effect: ['1.13', effect, (n, a) => (a.clear === true
    ? [`Removed (?:every effect|effect .+) from ${n}`, "Target (?:has no effects to remove|doesn't have the requested effect)"] : EFFECT_GIVEN(n))],
  whisper: [null, (a) => {
    const line = text(a.text, 'message');
    if (!line) throw refuse('text', 'The message is empty');
    return `msg ${name(a.target)} ${line}`;
  }, (n) => [`You whisper to ${n}: .*`]],
  kick: [null, (a) => withReason('kick', a), (n) => [`Kicked ${n}: .*`]],
  ban: [null, (a) => withReason('ban', a), (n) => [`Banned ${n}: .*`]],
  pardon: [null, (a) => `pardon ${name(a.target)}`, (n) => [`Unbanned ${n}`]],
  op: [null, (a) => `op ${name(a.target)}`, (n) => [`Made ${n} a server operator`]],
  deop: [null, (a) => `deop ${name(a.target)}`, (n) => [`Made ${n} no longer a server operator`]],
  whitelistAdd: [null, (a) => `whitelist add ${name(a.target)}`, (n) => [`Added ${n} to the whitelist`, 'Player is already whitelisted']],
  whitelistRemove: [null, (a) => `whitelist remove ${name(a.target)}`, (n) => [`Removed ${n} from the whitelist`, 'Player is not whitelisted']],
};
function expected(action, answers) {
  const [ok, own] = answers(action.target.replace(/\./g, '\\.'), action);
  return { ok: new RegExp(`^(?:${ok})$`, 'i'), refused: new RegExp(`^(?:${own ? `${own}|` : ''}${ANY_REFUSAL})`) };
}
// There is no heal or feed command. Both are instant effects, so they need a live, online player, and they do less than
// a button called Heal suggests.
const NOTES = {
  heal: 'Instant Health restores health at once, up to 4096 HP. It leaves fire, poison and other effects alone, and it does not revive a dead player.',
  feed: 'Saturation fills the food bar in one tick, 20 points and as much saturation as the bar allows. It does nothing for a dead player.',
};

function checkServer(action, version, kind, known) {
  if (kind === 'velocity') throw refuse('proxy', 'A proxy has no players of its own to act on');
  if (!action || typeof action !== 'object' || !known(action.type)) throw refuse('action', 'That is not a player action');
  if (typeof version !== 'string' || !RELEASE.test(version)) throw refuse('version', 'Nano Studio does not know the commands of this server\'s Minecraft version');
}
// action: {type, target, ...fields}. {version, kind}: the server's game version and kind.
// -> {commands: [line], expects: {ok, refused}, note?}, expects being the shapes of the server's answer.
function build(action, { version, kind } = {}) {
  checkServer(action, version, kind, (type) => Object.hasOwn(ACTIONS, type ?? ''));
  const [since, line, answers] = ACTIONS[action.type];
  if (since && !atLeast(version, since)) throw refuse('version', `This action needs Minecraft ${since} or newer, and this server runs ${version}`);
  const built = { commands: [line(action, version)], expects: expected(action, answers) };
  return NOTES[action.type] ? { ...built, note: NOTES[action.type] } : built;
}

// ---------- moving items ----------
// One action, moveItem: {target, op: 'move'|'clear'|'place', from, to, item, count, shown: {from, to}}. A slot is the game's
// number, with ENDER + n for the ender chest; shown holds the print of what the tab shows in each slot, or null for empty.
// A move onto a filled slot swaps them.
//
// Slots change one command at a time, and all the lines are already in one write when the first fails, so a failure does
// not stop the lines after it. A refused copy followed by a plain clear would delete the item it did not copy. What a line
// leaves in a slot proves nothing: another stack that looks the same can land there by itself. So a step records its own
// success with `execute store success`, and the next one starts from that record. A test that fails stores nothing, so
// each step has a key of its own under STORE's `ok`: one shared byte would still say 1 from the step before. A thrown
// command stores 0 (CommandDispatcher of 1.20.1, ContextChain.runExecutable of 26.3).
//
// Only chest, legs and feet refuse an item (createEquipmentSlotAccess in the real jars: head, hands and containers take
// anything), so needFit turns away what they would refuse, and a swap writes its armor slot first, where a refusal leaves
// only the temporary copy to remove. A player's own click in the ticks around the lines can still change a slot: the read
// afterwards shows that, and nothing is sent again.
const MOVE_FLOOR = '1.17';
const STORE = 'nano:move';
const PRINT = /^[0-9a-f]{40}$/;
const EQUIPPED = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head', [-106]: 'offhand' };
const WORN = { 102: /(?:_chestplate|:elytra)$/, 101: /_leggings$/, 100: /_boots$/ };
function needFit(slot, id) {
  if (WORN[slot] && !WORN[slot].test(id)) throw refuse('armorFit', `${id} does not go in ${slotName(slot)}`);
}
const shownPrint = (value) => {
  if (value === null || (typeof value === 'string' && PRINT.test(value))) return value;
  throw refuse('shown', 'The tab did not say what the slot holds');
};
// The action's own fields, checked: nothing here depends on what the server holds.
function checkMove(action, { version, kind } = {}) {
  checkServer(action, version, kind, (type) => type === 'moveItem');
  if (!atLeast(version, MOVE_FLOOR)) throw refuse('version', `This action needs Minecraft ${MOVE_FLOOR} or newer, and this server runs ${version}`);
  const { op } = action;
  if (op !== 'move' && op !== 'clear' && op !== 'place') throw refuse('action', 'That is not a way to move an item');
  const move = { target: name(action.target), op, shown: {} };
  if (op !== 'place') {
    slotName(action.from);
    move.from = action.from;
    move.shown.from = shownPrint(action.shown?.from ?? null);
    if (move.shown.from === null) throw refuse('emptySlot', 'That slot is empty');
  }
  if (op !== 'clear') {
    slotName(action.to);
    move.to = action.to;
    move.shown.to = shownPrint(action.shown?.to ?? null);
  }
  if (op === 'move' && move.from === move.to) throw refuse('sameSlot', 'The item is in that slot already');
  if (op === 'place') {
    move.item = resource(action.item, 'item');
    move.count = whole(action.count ?? 1, 1, MAX_SLOT, 'count');
    if (move.item === 'minecraft:air') throw refuse('item', 'Air is not an item to place');
    needFit(move.to, move.item);
  }
  return move;
}
// The last slot of the main inventory first: a player's pickups take the first free one.
function freeSlot(at, taken) {
  for (const slot of [...Array.from({ length: 27 }, (_, i) => 35 - i), ...Array.from({ length: 9 }, (_, i) => 8 - i)]) {
    if (!taken.includes(slot) && !at(slot)) return slot;
  }
  throw refuse('noRoom', 'The player has no empty inventory slot to swap through');
}
// plan: from checkMove. at(slot) -> the stack in it now, from the read just made.
// -> {commands, expects, wanted: [[slot, {print}|{id, count}|null]]}, wanted being what the slots hold when it worked.
function buildMove(plan, { version }, at) {
  const who = plan.target;
  // A slot's place in the player's data, narrowed to a stack by what the read just showed of it. The count too, so that
  // another stack of the same item landing there does not pass for this one. Only the fields the game printed, in its own
  // type: a form it does not print would match nothing, and the line would quietly not run.
  const inData = (slot, fields) => {
    if (slot >= ENDER) return `EnderItems[{Slot:${slot - ENDER}b${fields ? `,${fields}` : ''}}]`;
    if (EQUIPPED[slot] && atLeast(version, '1.21.5')) return `equipment.${EQUIPPED[slot]}${fields ? `{${fields}}` : ''}`;
    return `Inventory[{Slot:${slot}b${fields ? `,${fields}` : ''}}]`;
  };
  const fieldsOf = (stack) => {
    const { count, Count } = stack.raw ?? {};
    const sized = Number.isInteger(count) ? `,count:${count}` : Number.isInteger(Count) ? `,Count:${Count}b` : '';
    return `id:"${resource(stack.id, 'item')}"${sized}`;
  };
  const has = (slot, fields) => `if data entity ${who} ${inData(slot, fields)}`;
  const free = (slot) => `unless data entity ${who} ${inData(slot)}`;
  // A line that overwrites a stack has no step before it to rest on, so it tests all of the stack, as the game printed it.
  // A text with a raw line break (1.20.1) cannot go on a console line and its parser has no escape for one.
  const hasWhole = (slot) => {
    const whole = printOfStack(at(slot));
    if (!whole || /[\r\n]/.test(whole)) return has(slot, fieldsOf(at(slot)));
    if (slot >= ENDER) return `if data entity ${who} EnderItems[${whole}]`;
    if (EQUIPPED[slot] && atLeast(version, '1.21.5')) return `if data entity ${who} equipment.${EQUIPPED[slot]}${whole}`;
    return `if data entity ${who} Inventory[${whole}]`;
  };
  const did = (step) => `if data storage ${STORE} {ok:{${step}:1b}}`;
  const didNot = (step) => `unless data storage ${STORE} {ok:{${step}:1b}}`;
  const line = (tests, what, step) => `execute ${tests.join(' ')}${step ? ` store success storage ${STORE} ok.${step} byte 1` : ''} run item replace entity ${who} ${what}`;
  const copy = (to, from) => `${slotName(to)} from entity ${who} ${slotName(from)}`;
  const wipe = (slot) => `${slotName(slot)} with minecraft:air`;
  const stack = (slot) => ({ print: at(slot).print });
  const OPEN = `data modify storage ${STORE} ok set value {}`;
  const CLOSE = `data remove storage ${STORE} ok`;
  let commands;
  let wanted;
  if (plan.op === 'clear') {
    commands = [line([hasWhole(plan.from)], wipe(plan.from))];
    wanted = [[plan.from, null]];
  } else if (plan.op === 'place') {
    commands = [line([at(plan.to) ? hasWhole(plan.to) : free(plan.to)], `${slotName(plan.to)} with ${plan.item} ${plan.count}`)];
    wanted = [[plan.to, { id: plan.item, count: plan.count }]];
  } else if (!at(plan.to)) {
    const { from, to } = plan;
    const x = fieldsOf(at(from));
    needFit(to, at(from).id);
    commands = [
      OPEN,
      line([has(from, x), free(to)], copy(to, from), 'copied'),
      line([did('copied'), has(from, x)], wipe(from), 'wiped'),
      // The source changed after the copy, so the copy is one stack too many.
      line([did('copied'), didNot('wiped'), has(to, x)], wipe(to)),
      CLOSE,
    ];
    wanted = [[to, stack(from)], [from, null]];
  } else {
    const [from, to] = WORN[plan.from] ? [plan.to, plan.from] : [plan.from, plan.to];
    const [x, y] = [fieldsOf(at(from)), fieldsOf(at(to))];
    needFit(to, at(from).id);
    needFit(from, at(to).id);
    const temp = freeSlot(at, [from, to]);
    commands = [
      OPEN,
      line([has(from, x), has(to, y), free(temp)], copy(temp, to), 'saved'),
      line([did('saved'), has(from, x), has(to, y)], copy(to, from), 'moved'),
      // `to` was not written, so what temp holds is only a copy.
      line([did('saved'), didNot('moved'), has(temp, y)], wipe(temp)),
      line([did('moved'), has(from, x), has(temp, y)], copy(from, temp), 'placed'),
      // `to` was written and `from` was not: temp holds the only y, and x is in `to` as well as where it was.
      line([did('moved'), didNot('placed'), has(to, x), has(temp, y)], copy(to, temp), 'placed'),
      line([did('placed'), has(temp, y)], wipe(temp)),
      CLOSE,
    ];
    wanted = [[to, stack(from)], [from, stack(to)], [temp, null]];
  }
  const answers = (n) => [`Replaced (?:a slot|\\d+ slot\\(s\\)) on ${n}(?: with .+)?`, 'No targets accepted item|The (?:target|source) does not have |.+ can only stack up to \\d+'];
  return { commands: [...commands, `data get entity ${who}`], expects: expected({ target: who }, answers), wanted };
}
// wanted: from buildMove. at: the stacks as read afterwards. -> [{slot, name, wanted, got}] for each slot not as wanted.
function moveDiff(wanted, at) {
  const out = [];
  for (const [slot, want] of wanted) {
    const got = at(slot);
    const same = !want ? !got : want.print ? got?.print === want.print : got?.id === want.id && got?.count === want.count;
    if (!same) out.push({ slot, name: slotName(slot), wanted: want, got: got ? { id: got.id, count: got.count } : null });
  }
  return out;
}

// Whether the player holds what a move should leave, whatever slot it is in. The slots of a move can all look right after
// a click that doubled or lost a stack elsewhere. A stack the player picks up in the same moment reads as a change too,
// which only costs a warning.
function sameStacks(plan, before, after) {
  const all = (d) => [...d.inventory, ...d.armor, ...(d.offhand ? [d.offhand] : []), ...d.ender];
  const then = all(before).map((s) => s.print);
  const now = all(after);
  const drop = (list, print) => { const at = list.indexOf(print); if (at !== -1) list.splice(at, 1); };
  if (plan.op === 'clear') drop(then, slotIn(before, plan.from)?.print);
  if (plan.op === 'place') {
    drop(then, slotIn(before, plan.to)?.print);
    const made = now.findIndex((s) => s.id === plan.item && s.count === plan.count);
    if (made === -1) return false;
    now.splice(made, 1);
  }
  return then.sort().join() === now.map((s) => s.print).sort().join();
}

// Every slot that differs between two reads, with what the game printed for it: enough to put a stack back by hand.
function changedSlots(before, after) {
  const slots = (d) => new Map([...d.inventory, ...d.armor, ...(d.offhand ? [d.offhand] : []), ...d.ender.map((s) => ({ ...s, slot: s.slot + ENDER }))].map((s) => [s.slot, s]));
  const [was, now] = [slots(before), slots(after)];
  return [...new Set([...was.keys(), ...now.keys()])].filter((slot) => was.get(slot)?.print !== now.get(slot)?.print)
    .map((slot) => ({ slot, name: slotName(slot), before: printOfStack(was.get(slot)), after: printOfStack(now.get(slot)) }));
}

module.exports = { build, checkMove, buildMove, moveDiff, sameStacks, changedSlots, atLeast, NAME, CHECKED_THROUGH };
