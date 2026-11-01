// A player's inventory that runs the console lines of a moveItem, for the Node tests and the window test's stand-in server.
// Its rules are read from the real jars' classes, not from a running game: which slots refuse which items
// (createEquipmentSlotAccess), that `execute ... run` says nothing when a test fails and stores nothing then, that a command
// that throws stores 0 and one that works stores 1 (ExecuteCommand.storeData with CommandDispatcher of 1.20.1 and
// ContextChain of 26.3), that a setting that changes nothing fails (DataCommands), the answers' wording (en_us.json of 26.3
// and 1.20.1), and where armor lies in a player's data. What a real server does with these lines stays unproven here.
const SLOT = { 'armor.feet': 100, 'armor.legs': 101, 'armor.chest': 102, 'armor.head': 103, 'weapon.offhand': -106 };
const WORN = { 100: /_boots$/, 101: /_leggings$/, 102: /(_chestplate|:elytra)$/ };
const KEYS = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head', [-106]: 'offhand' };
const pretty = (id) => id.replace(/^[^:]*:/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const isNew = (version) => { const [a, b, c = 0] = version.split('.').map(Number); return a > 1 || b > 21 || (b === 21 && c >= 5); };
const usesCount = (version) => { const [a, b, c = 0] = version.split('.').map(Number); return a > 1 || b > 20 || (b === 20 && c >= 5); };

function slotOf(name) {
  if (SLOT[name] !== undefined) return SLOT[name];
  const m = /^(hotbar|inventory|enderchest)\.(\d+)$/.exec(name);
  if (!m) return null;
  return { hotbar: 0, inventory: 9, enderchest: 200 }[m[1]] + Number(m[2]);
}

// A command's words: a path holds spaces inside its brackets and its quotes.
function words(line) {
  const out = [];
  let word = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      word += c;
      if (c === '\\') word += line[++i];
      else if (c === quote) quote = '';
    } else if (c === ' ' && !depth) {
      out.push(word);
      word = '';
    } else {
      if (c === '"' || c === "'") quote = c;
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
      word += c;
    }
  }
  return [...out, word];
}

// stacks: {slot: {id, count, extra?}}, extra being SNBT fields of the stack's own, such as `components: {...}`.
function createGame({ version, name, stacks = {} }) {
  const held = new Map(Object.entries(stacks).map(([k, v]) => [Number(k), { ...v }]));
  const storage = {};
  const snbt = (s, slot) => `{${slot === null ? '' : `Slot: ${slot}b, `}id: "${s.id}", ${usesCount(version) ? `count: ${s.count}` : `Count: ${s.count}b`}${s.extra ? `, ${s.extra}` : ''}}`;
  const out = isNew(version);
  function data() {
    const list = [...held].sort(([a], [b]) => a - b);
    const main = list.filter(([k]) => k < 200 && (k >= 0 && k <= 35 || !out)).map(([k, s]) => snbt(s, k));
    const ender = list.filter(([k]) => k >= 200).map(([k, s]) => snbt(s, k - 200));
    const worn = out ? list.filter(([k]) => KEYS[k]).map(([k, s]) => `${KEYS[k]}: ${snbt(s, null)}`) : [];
    return `{Health: 20.0f, foodLevel: 20, XpLevel: 0, playerGameType: 0, SelectedItemSlot: 0, Pos: [1.0d, 64.0d, 1.0d], Dimension: "minecraft:overworld", Inventory: [${main.join(', ')}], ${worn.length ? `equipment: {${worn.join(', ')}}, ` : ''}EnderItems: [${ender.join(', ')}]}`;
  }
  // Whether a path of the kinds actions.js writes finds something.
  const matches = (s, fields) => {
    if (!s) return false;
    if (!fields) return true;
    const m = /^id:"([^"]+)"(?:,count:(\d+)|,Count:(\d+)b)?$/.exec(fields);
    if (!m || s.id !== m[1]) return false;
    // Numbers compare by type in the game's data, so the old format's byte does not match an int and the reverse.
    if (m[2] !== undefined) return usesCount(version) && s.count === Number(m[2]);
    if (m[3] !== undefined) return !usesCount(version) && s.count === Number(m[3]);
    return true;
  };
  function has(path) {
    let m = /^(Inventory|EnderItems)\[\{Slot:(-?\d+)b(?:,(.+))?\}\]$/.exec(path);
    if (m) {
      if (m[1] === 'Inventory' && out && KEYS[Number(m[2])]) return false;
      return matches(held.get(Number(m[2]) + (m[1] === 'EnderItems' ? 200 : 0)), m[3]);
    }
    // A whole stack, as the game printed it.
    m = /^(Inventory|EnderItems)\[(\{Slot: (-?\d+)b, .+\})\]$/.exec(path);
    if (m) {
      const stack = held.get(Number(m[3]) + (m[1] === 'EnderItems' ? 200 : 0));
      return !!stack && m[2] === snbt(stack, Number(m[3]));
    }
    m = /^equipment\.(\w+)(\{id: .+\})$/.exec(path);
    const worn = (key) => held.get(Number(Object.keys(KEYS).find((k) => KEYS[k] === key)));
    if (m && out) return !!worn(m[1]) && m[2] === snbt(worn(m[1]), null);
    m = /^equipment\.(\w+)(?:\{(.+)\})?$/.exec(path);
    if (m && out) return matches(worn(m[1]), m[2]);
    return null;
  }
  const replaced = (id) => (usesCount(version) ? `Replaced 1 slot(s) on ${name} with [${pretty(id)}]` : `Replaced a slot on ${name} with [${pretty(id)}]`);
  const game = {
    held, storage, data, run,
    // A slot that refuses a stack beyond what WORN knows: a mod's item, or a test's.
    refuses: () => false,
    // A player's own click: only the game's state changes.
    swap(a, b) {
      const [x, y] = [held.get(a), held.get(b)];
      if (y) held.set(a, y); else held.delete(a);
      if (x) held.set(b, x); else held.delete(b);
    },
    // Every stack on the player, whatever slot: what must be the same after a move.
    stacks: () => [...held.values()].map((s) => `${s.id}*${s.count}${s.extra ? `|${s.extra}` : ''}`).sort(),
    all: () => game.stacks().join(' '),
  };
  // -> [what the console is told, whether it worked].
  function put(slot, stack) {
    if (stack && ((WORN[slot] && !WORN[slot].test(stack.id)) || game.refuses(slot, stack))) return [`No targets accepted item [${pretty(stack.id)}] into specified slots`, false];
    if (stack) held.set(slot, { ...stack });
    else held.delete(slot);
    return [replaced(stack?.id ?? 'minecraft:air'), true];
  }
  function item(line) {
    const n = name.replace(/\./g, '\\.');
    let m = new RegExp(`^item replace entity ${n} (\\S+) from entity ${n} (\\S+)$`).exec(line);
    if (m) {
      const [to, from] = [slotOf(m[1]), slotOf(m[2])];
      if (to === null || from === null) return [`Unknown slot '${m[1]}'`, false];
      return put(to, held.get(from) ?? null);
    }
    m = new RegExp(`^item replace entity ${n} (\\S+) with (\\S+)(?: (\\d+))?$`).exec(line);
    if (!m) return null;
    const slot = slotOf(m[1]);
    if (slot === null) return [`Unknown slot '${m[1]}'`, false];
    return put(slot, m[2] === 'minecraft:air' ? null : { id: m[2], count: Number(m[3] ?? 1) });
  }
  function dataLine(line) {
    let m = /^data modify storage nano:move ok set value \{\}$/.exec(line);
    if (m) {
      if (storage.ok && !Object.keys(storage.ok).length) return ['Nothing changed. The specified properties already have these values'];
      storage.ok = {};
      return ['Modified storage nano:move'];
    }
    m = /^data remove storage nano:move ok$/.exec(line);
    if (!m) return null;
    if (!storage.ok) return ['Found no elements matching ok'];
    delete storage.ok;
    return ['Modified storage nano:move'];
  }
  // One word group of an execute line -> whether it lets the line go on.
  const test = (word, kind, target, path) => {
    const found = kind === 'storage' ? storage.ok?.[/^\{ok:\{(\w+):1b\}\}$/.exec(path)[1]] === 1 : has(path);
    return found === (word === 'if');
  };
  // One console line -> what the console is told, or null for a line of another kind.
  function run(line) {
    if (line.startsWith('data ')) return dataLine(line);
    if (!line.startsWith('execute ')) {
      const said = item(line);
      return said && [said[0]];
    }
    const parts = words(line.slice('execute '.length));
    let store = null;
    let i = 0;
    while (parts[i] !== 'run') {
      if (parts[i] === 'store') {
        if (parts[i + 1] !== 'success' || parts[i + 2] !== 'storage' || parts[i + 3] !== 'nano:move' || parts[i + 5] !== 'byte' || parts[i + 6] !== '1') return null;
        store = parts[i + 4].replace(/^ok\./, '');
        i += 7;
      } else {
        if (parts[i + 1] !== 'data') return null;
        if (!test(parts[i], parts[i + 2], parts[i + 3], parts[i + 4])) return [];
        i += 5;
      }
    }
    const said = item(parts.slice(i + 1).join(' '));
    if (!said) return null;
    if (store) (storage.ok ??= {})[store] = said[1] ? 1 : 0;
    return [said[0]];
  }
  return game;
}

module.exports = { createGame };
