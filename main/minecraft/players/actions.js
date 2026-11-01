// A player action -> the console lines that do it, for a server's game version. Pure: nothing here runs a command.
// build() throws an error with {expected: true, code} for anything it will not write, because a form it is not sure of
// must not reach a console.
//
// Forms as checked on minecraft.wiki, against 26.3:
//   give, clear           Commands/give, Commands/clear; {tag} NBT and [components]: Java Edition 1.20.5
//   Enchantments, lvl     Item format/Before 1.20.5 (1.13 snapshot 18w21a named it Enchantments), NBT format (the s suffix)
//   enchantments={levels:{...}} and the flat form    Data component format history, Java Edition 1.21.5 (25w04a)
//   stored_enchantments   Data component format history
//   item replace entity   Commands/item, Java Edition 21w19a; slot names: Slot
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
function slotName(slot) {
  if (Number.isInteger(slot) && slot >= 0 && slot <= 8) return `hotbar.${slot}`;
  if (Number.isInteger(slot) && slot >= 9 && slot <= 35) return `inventory.${slot - 9}`;
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

// action: {type, target, ...fields}. {version, kind}: the server's game version and kind.
// -> {commands: [line], expects: {ok, refused}, note?}, expects being the shapes of the server's answer.
function build(action, { version, kind } = {}) {
  if (kind === 'velocity') throw refuse('proxy', 'A proxy has no players of its own to act on');
  if (!action || typeof action !== 'object' || !Object.hasOwn(ACTIONS, action.type ?? '')) throw refuse('action', 'That is not a player action');
  if (typeof version !== 'string' || !RELEASE.test(version)) throw refuse('version', 'Nano Studio does not know the commands of this server\'s Minecraft version');
  const [since, line, answers] = ACTIONS[action.type];
  if (since && !atLeast(version, since)) throw refuse('version', `This action needs Minecraft ${since} or newer, and this server runs ${version}`);
  const built = { commands: [line(action, version)], expects: expected(action, answers) };
  return NOTES[action.type] ? { ...built, note: NOTES[action.type] } : built;
}

module.exports = { build, NAME, CHECKED_THROUGH };
