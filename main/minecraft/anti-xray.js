// Paper's built-in anti-xray as the Server Settings tab edits it: config/paper-world-defaults.yml for the overworld and
// each other dimension's paper-world.yml for its own lists. There is no YAML library here and these files hold comments
// and the owner's other settings, so the block is found and changed line by line, and anything that is not shaped as
// Paper writes it is refused rather than guessed at. A server that has not run yet has no files: its level waits in
// pyide-server.json (antiXrayPending) and settle() applies it once they exist.
// Sources: docs.papermc.io/paper/anti-xray (the lists below, the modes, the End) and /paper/reference/world-configuration
// (keys and defaults); Paper's EngineMode.java (an unknown mode throws, and mode 3 is in ver/1.21.4 and later);
// papermc.io/news/paper-1-19 (paper.yml split up in 1.19); papermc.io/news/26-1 (dimensions moved inside the world folder).
const fs = require('fs');
const path = require('path');
const { readProperties } = require('./server-settings');

const DEFAULTS = path.join('config', 'paper-world-defaults.yml');
const WORLD_FILE = 'paper-world.yml';
const BACKUP = '.nano-backup';
const TMP = '.nano-tmp';
const MAX_BYTES = 4 << 20;

const list = (s) => s.trim().split(/\s+/);
// Mode 1 hides what is buried, so its list is only what is worth hiding.
const HIDE = {
  overworld: list(`chest coal_ore deepslate_coal_ore copper_ore deepslate_copper_ore raw_copper_block diamond_ore
    deepslate_diamond_ore emerald_ore deepslate_emerald_ore gold_ore deepslate_gold_ore iron_ore deepslate_iron_ore
    raw_iron_block lapis_ore deepslate_lapis_ore redstone_ore deepslate_redstone_ore`),
  nether: list('ancient_debris nether_gold_ore nether_quartz_ore'),
};
// Modes 2 and 3 paint hidden-blocks over replacement-blocks, so a tile entity (chest) can only be in the second list.
const OBFUSCATE = {
  overworld: {
    hidden: list(`air copper_ore deepslate_copper_ore raw_copper_block diamond_ore deepslate_diamond_ore gold_ore
      deepslate_gold_ore iron_ore deepslate_iron_ore raw_iron_block lapis_ore deepslate_lapis_ore redstone_ore
      deepslate_redstone_ore`),
    replacement: list(`chest amethyst_block andesite budding_amethyst calcite coal_ore deepslate_coal_ore deepslate diorite
      dirt emerald_ore deepslate_emerald_ore granite gravel oak_planks smooth_basalt stone tuff`),
  },
  nether: {
    hidden: list('air ancient_debris bone_block glowstone magma_block nether_bricks nether_gold_ore nether_quartz_ore polished_blackstone_bricks'),
    replacement: list('basalt blackstone gravel netherrack soul_sand soul_soil'),
  },
};
const HEIGHT = { overworld: 64, nether: 128 };
const MODE = { basic: 1, strong: 2, layers: 3 };
const LEVELS = ['off', 'basic', 'strong', 'layers'];
// What a new server may start with: the setting takes no mode 3, which some Paper versions would refuse to load.
const NEW_SERVER_LEVELS = ['basic', 'strong'];
const WORLDS = { overworld: ['overworld', ''], nether: ['the_nether', '_nether'], end: ['the_end', '_the_end'] };

// The keys a level sets in a dimension. update-radius, lava-obscures and use-permission stay the owner's. Mode 1 ignores
// replacement-blocks, so that list is left alone.
function wanted(level, world) {
  if (level === 'off' || world === 'end') return { enabled: false };
  const mode = MODE[level];
  const lists = mode === 1 ? { 'hidden-blocks': HIDE[world] }
    : { 'hidden-blocks': OBFUSCATE[world].hidden, 'replacement-blocks': OBFUSCATE[world].replacement };
  return { enabled: true, 'engine-mode': mode, ...lists, 'max-block-height': HEIGHT[world] };
}

const refused = (code) => Object.assign(new Error(`anti-xray: ${code}`), { refusal: code });

// ---------- versions and kinds ----------
function atLeast(mc, ...floor) {
  const v = (String(mc ?? '').match(/\d+/g) || []).map(Number);
  for (let i = 0; i < floor.length; i++) if ((v[i] || 0) !== floor[i]) return (v[i] || 0) > floor[i];
  return true;
}
const levelsFor = (mc) => LEVELS.filter((l) => l !== 'layers' || atLeast(mc, 1, 21, 4));
const supportOf = (srv) => (srv.proxy ? 'proxy' : srv.mods ? 'modded' : srv.plugins !== 'paper' ? 'vanilla' : atLeast(srv.mc, 1, 19) ? 'paper' : 'tooOld');
const pendingOf = (srv) => (levelsFor(srv.mc).includes(srv.pending) && srv.pending !== 'off' ? srv.pending : null);
// The level a server starts with when it is created: `chosen` is the app-wide default.
const newServerLevel = (srv, chosen) => (NEW_SERVER_LEVELS.includes(chosen) && supportOf(srv) === 'paper' ? chosen : null);

// ---------- one file ----------
const lineIndent = (s) => s.search(/\S/);
const isList = (s) => /^\s*-(\s|$)/.test(s);
const splitNote = (raw) => {
  const m = /(^|\s)#/.exec(raw);
  return m ? [raw.slice(0, m.index).trim(), raw.slice(m.index).trim()] : [raw.trim(), ''];
};
const blockId = (s) => {
  const id = s.replace(/^(['"])(.*)\1$/, '$2').replace(/^minecraft:/, '');
  if (!/^[a-z0-9_.:/-]+$/.test(id)) throw refused('shape');
  return id;
};
// Whether a line opens a quoted value it does not close. The lines after it are text, whatever they look like, and a text
// may reach column 0 at the top of a file.
function opensQuote(line) {
  let rest = line.trim().replace(/^(?:-\s+)+/, '');
  for (;;) {
    const quoted = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'(?!'))/.exec(rest)?.[0] ?? '';
    if (!quoted && /^["']/.test(rest)) return true;
    const key = quoted ? /^\s*:\s+/.exec(rest.slice(quoted.length)) : /^[^#]*?:\s+/.exec(rest);
    if (!key) return false;
    rest = rest.slice(quoted.length + key[0].length);
  }
}

// Where the block lies in the file's lines. keys is null when the file has no anti-xray block; top and last then say
// where one can go. Lines keep their \r, so what is not changed is written back byte for byte.
function parse(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const lines = text.slice(bom.length).split('\n');
  const bare = lines.map((l) => l.replace(/\r$/, ''));
  const seen = bare.flatMap((l, i) => (/^\s*(#|$)/.test(l) ? [] : [i]));
  const doc = { bom, lines, crlf: lines.some((l) => l.endsWith('\r')), top: null, keys: null, last: -1, indent: 0, childIndent: 2 };
  bare.forEach((l, i) => { if (/\S/.test(l)) doc.last = i; });
  seen.forEach((i, n) => {
    const l = bare[i];
    if (/^\s*\t/.test(l) || /^\.\.\.(\s|$)/.test(l) || (n > 0 && /^---(\s|$)/.test(l))) throw refused('shape');
    if (lineIndent(l) === 0 && !isList(l) && !/^---(\s|$)/.test(l) && !/^[^\s{[][^#]*:(\s|$)/.test(l)) throw refused('shape');
    if (opensQuote(l)) throw refused('shape');
  });
  // What follows the block is added at column 0, which only goes with a map that starts there.
  const root = /^---\s*(#.*)?$/.test(bare[seen[0]] ?? '') ? seen[1] : seen[0];
  if (root !== undefined && (lineIndent(bare[root]) > 0 || isList(bare[root]) || /^---\s/.test(bare[root]))) throw refused('shape');

  const tops = seen.filter((i) => /^['"]?anticheat['"]?\s*:/.test(bare[i]));
  if (tops.length > 1) throw refused('shape');
  if (!tops.length) return doc;
  const [top] = tops;
  if (!/^anticheat:\s*(#.*)?$/.test(bare[top])) throw refused('shape');
  doc.top = top;
  const end = seen.find((i) => i > top && lineIndent(bare[i]) === 0 && !isList(bare[i])) ?? Infinity;
  const under = seen.filter((i) => i > top && i < end);
  doc.childIndent = under.length ? lineIndent(bare[under[0]]) : 2;
  if (under.some((i) => lineIndent(bare[i]) < doc.childIndent)) throw refused('shape');
  doc.last = under.at(-1) ?? top;

  const named = under.filter((i) => lineIndent(bare[i]) === doc.childIndent && /^\s*['"]?anti-xray['"]?\s*:/.test(bare[i]));
  if (named.length > 1) throw refused('shape');
  if (!named.length) return doc;
  const [at] = named;
  if (!/^\s*anti-xray:\s*(#.*)?$/.test(bare[at])) throw refused('shape');
  const stop = under.find((i) => i > at && lineIndent(bare[i]) <= doc.childIndent) ?? Infinity;
  const inner = under.filter((i) => i > at && i < stop);
  doc.indent = inner.length ? lineIndent(bare[inner[0]]) : doc.childIndent + 2;
  if (inner.some((i) => lineIndent(bare[i]) < doc.indent)) throw refused('shape');
  doc.last = inner.at(-1) ?? at;

  doc.keys = new Map();
  let current = null;
  for (const i of inner) {
    if (lineIndent(bare[i]) === doc.indent && !isList(bare[i])) {
      const m = /^\s*([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(bare[i]);
      if (!m || doc.keys.has(m[1])) throw refused('shape');
      const [value, note] = splitNote(m[2] ?? '');
      current = { line: i, value, note, rows: [] };
      doc.keys.set(m[1], current);
    } else {
      if (!current) throw refused('shape');
      current.rows.push(i);
    }
  }
  doc.bare = bare;
  return doc;
}

function scalarOf(entry) {
  if (entry.rows.length) throw refused('shape');
  if (entry.value === 'true' || entry.value === 'false') return entry.value === 'true';
  if (/^-?\d+$/.test(entry.value)) return Number(entry.value);
  throw refused('shape');
}
// The items of a list: [{id, line}], or a line of null for one written in brackets on the key's line.
function itemsOf(doc, entry) {
  if (entry.value) {
    const m = /^\[(.*)\]$/.exec(entry.value);
    if (!m || entry.rows.length) throw refused('shape');
    return m[1].trim() ? m[1].split(',').map((s) => ({ id: blockId(s.trim()), line: null })) : [];
  }
  const indent = entry.rows.length ? lineIndent(doc.bare[entry.rows[0]]) : 0;
  return entry.rows.map((i) => {
    const m = /^( *)-\s+(.*)$/.exec(doc.bare[i]);
    if (!m || m[1].length !== indent) throw refused('shape');
    return { id: blockId(splitNote(m[2])[0]), line: i };
  });
}
const sameValue = (a, b) => (Array.isArray(b) ? Array.isArray(a) && new Set(a).size === new Set(b).size && b.every((x) => a.includes(x)) : a === b);

// What the file's block says, of the keys a level sets; null without a block.
function readBlock(text) {
  const doc = parse(text);
  if (!doc.keys) return null;
  const out = {};
  for (const key of ['enabled', 'engine-mode', 'max-block-height']) if (doc.keys.has(key)) out[key] = scalarOf(doc.keys.get(key));
  for (const key of ['hidden-blocks', 'replacement-blocks']) if (doc.keys.has(key)) out[key] = itemsOf(doc, doc.keys.get(key)).map((x) => x.id);
  return out;
}

function insertAfter(doc, at, rows) {
  const cr = doc.crlf ? '\r' : '';
  const atEnd = at === doc.lines.length - 1;
  if (atEnd && doc.lines[at] !== null) doc.lines[at] += cr;
  doc.lines.splice(at + 1, 0, ...rows.map((r, n) => r + (atEnd && n === rows.length - 1 ? '' : cr)));
}
const written = (doc) => doc.bom + doc.lines.filter((l) => l !== null).join('\n');
const listRows = (pad, key, value) => (value.length ? [`${pad}${key}:`, ...value.map((id) => `${pad}- ${id}`)] : [`${pad}${key}: []`]);

// One key, from the file as it is now: an unchanged value leaves the text as it was.
function setKey(text, key, value) {
  const doc = parse(text);
  const entry = doc.keys.get(key);
  const pad = ' '.repeat(doc.indent);
  if (!entry) {
    insertAfter(doc, doc.last, Array.isArray(value) ? listRows(pad, key, value) : [`${pad}${key}: ${value}`]);
    return written(doc);
  }
  const setLine = (shown) => {
    const cr = doc.lines[entry.line].endsWith('\r') ? '\r' : '';
    doc.lines[entry.line] = `${[`${pad}${key}:`, shown, entry.note].filter(Boolean).join(' ')}${cr}`;
  };
  if (!Array.isArray(value)) {
    if (scalarOf(entry) === value) return text;
    setLine(String(value));
    return written(doc);
  }
  const items = itemsOf(doc, entry);
  const had = items.map((x) => x.id);
  if (sameValue(had, value)) return text;
  if (!items.length || items[0].line === null) {
    setLine(value.length ? '' : '[]');
    if (value.length) insertAfter(doc, entry.line, value.map((id) => `${pad}- ${id}`));
    return written(doc);
  }
  // Items that stay keep their place, and comments between them stay too.
  const itemPad = ' '.repeat(lineIndent(doc.bare[items[0].line]));
  const fresh = value.filter((id) => !had.includes(id));
  if (fresh.length) insertAfter(doc, items.at(-1).line, fresh.map((id) => `${itemPad}- ${id}`));
  for (const x of items) if (!value.includes(x.id)) doc.lines[x.line] = null;
  if (!value.length) setLine('[]');
  return written(doc);
}

// The text with the keys of `want` set. create: a file without the block gets one (a paper-world.yml holds only what
// differs from the defaults); the defaults file always has it, so there a missing block means it is not what we expect.
function edit(text, want, create) {
  const doc = parse(text);
  let out = text;
  if (!doc.keys) {
    if (!create) throw refused('noBlock');
    if (doc.top === null) insertAfter(doc, doc.last, ['anticheat:', '  anti-xray:']);
    else insertAfter(doc, doc.last, [`${' '.repeat(doc.childIndent)}anti-xray:`]);
    out = written(doc);
  }
  for (const [key, value] of Object.entries(want)) out = setKey(out, key, value);
  return out;
}

// ---------- a server's files ----------
function scan(dir, file) {
  const named = (err) => { if (err.refusal) err.file = path.relative(dir, file).replace(/\\/g, '/'); return err; };
  if (!fs.existsSync(file)) return { file, text: null, block: null };
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw refused('shape');
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) throw refused('notText');
    return { file, text, block: readBlock(text) };
  } catch (err) { throw named(err); }
}

// The dimensions' files and what each ends up with: its own block over the defaults.
function survey(dir, srv) {
  const props = readProperties(path.join(dir, 'server.properties'));
  const name = props['level-name'] || 'world';
  // It becomes a path, and server.properties is the project's file. A UNC path here would also reach out to a share.
  if (!/^[^\\/:*?"<>|]+$/.test(name) || /^\.+$/.test(name)) throw Object.assign(refused('badWorld'), { file: 'server.properties' });
  const fileOf = (world) => path.join(dir, ...(atLeast(srv.mc, 26) ? [name, 'dimensions', 'minecraft', WORLDS[world][0]] : [`${name}${WORLDS[world][1]}`]), WORLD_FILE);

  const defaults = scan(dir, path.join(dir, DEFAULTS));
  if (!defaults.block) throw Object.assign(refused('noBlock'), { file: DEFAULTS.replace(/\\/g, '/') });
  const own = scan(dir, fileOf('overworld'));
  if (own.block) throw Object.assign(refused('override'), { file: path.relative(dir, own.file).replace(/\\/g, '/') });

  const worlds = [{ ...defaults, id: 'overworld', values: defaults.block }];
  for (const id of ['nether', 'end']) {
    const w = scan(dir, fileOf(id));
    if (id === 'nether' && props['allow-nether'] === 'false' && w.text === null) continue;
    worlds.push({ ...w, id, values: { ...defaults.block, ...w.block } });
  }
  return { worlds, version: /^_version:\s*(\d+)\s*$/m.exec(defaults.text)?.[1] ?? null };
}

const fits = (w, level) => Object.entries(wanted(level, w.id)).every(([k, v]) => sameValue(w.values[k], v));

// The tab's model of the section. state: ready, notStarted, refused, or a kind without anti-xray to set (vanilla, modded,
// proxy, tooOld). level is custom when the files say something no level does.
function status(dir, srv) {
  const support = supportOf(srv);
  if (support !== 'paper') return { state: support };
  const base = { levels: levelsFor(srv.mc), pending: pendingOf(srv) };
  if (!fs.existsSync(path.join(dir, DEFAULTS))) return { ...base, state: 'notStarted' };
  try {
    const { worlds } = survey(dir, srv);
    return { ...base, state: 'ready', level: LEVELS.find((l) => worlds.every((w) => fits(w, l))) ?? 'custom',
      worlds: Object.fromEntries(worlds.map((w) => [w.id, LEVELS.find((l) => fits(w, l)) ?? 'custom'])) };
  } catch (err) { return { ...base, state: 'refused', ...refusalOf(err) }; }
}
const refusalOf = (err) => (err.refusal ? { code: err.refusal, file: err.file || '' } : { code: 'unreadable', file: '', detail: err.message });

// -> {changes} to hand to commit(), or {refused: {code, file}}. Nothing is written, so a refusal stops a Save whole.
function planned(dir, srv, level) {
  try {
    if (supportOf(srv) !== 'paper' || !levelsFor(srv.mc).includes(level)) throw refused('level');
    const { worlds, version } = survey(dir, srv);
    const changes = worlds.flatMap((w) => {
      // A dimension that follows the defaults is off with them: no file to write.
      if (level === 'off' && w.id !== 'overworld' && !w.block) return [];
      const start = w.text ?? (version ? `_version: ${version}\n` : '');
      const text = edit(start, wanted(level, w.id), w.id !== 'overworld');
      return text === w.text ? [] : [{ file: w.file, name: path.relative(dir, w.file).replace(/\\/g, '/'), before: w.text, text }];
    });
    return { changes };
  } catch (err) { return { refused: refusalOf(err) }; }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renamed(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (i === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      pause(25);
    }
  }
}
// Each file back as it was, by the same rename that changed it: a write in place that fails halfway would leave half a
// settings file. -> the names of those that would not go back.
function rollBack(done) {
  const left = [];
  for (const c of done) {
    try {
      if (c.before === null) fs.rmSync(c.file, { force: true });
      else {
        fs.writeFileSync(`${c.file}${TMP}`, c.before);
        renamed(`${c.file}${TMP}`, c.file);
      }
    } catch { left.push(c.name); }
  }
  return left;
}
// All the files or none. A temporary file left by a crash has a fixed name, so the next run writes over it. The backup is
// the file as it was before this app first changed it, and is never replaced. -> null, or why not, as a refusal: partial
// when a file could not be put back, which is the one case that leaves the server's files mixed.
function commit(changes) {
  const done = [];
  try {
    for (const c of changes) {
      fs.mkdirSync(path.dirname(c.file), { recursive: true });
      fs.writeFileSync(`${c.file}${TMP}`, c.text);
    }
    for (const c of changes) if (c.before !== null && !fs.existsSync(`${c.file}${BACKUP}`)) fs.copyFileSync(c.file, `${c.file}${BACKUP}`);
    for (const c of changes) { renamed(`${c.file}${TMP}`, c.file); done.push(c); }
    return null;
  } catch (err) {
    const left = rollBack(done);
    return { code: left.length ? 'partial' : 'unwritable', file: left.join(', '), detail: err.message };
  } finally {
    for (const c of changes) { try { fs.rmSync(`${c.file}${TMP}`, { force: true }); } catch {} }
  }
}

function applied(dir, srv, level) {
  const plan = planned(dir, srv, level);
  if (plan.refused) return plan;
  const refused = commit(plan.changes);
  return refused ? { refused } : { changes: plan.changes.length };
}

// One server of "apply to my other servers". pending, when present, is what pyide-server.json should say now (null: nothing).
function assign(dir, srv, level) {
  const st = status(dir, srv);
  if (!st.levels) return { outcome: 'skipped', state: st.state };
  if (!st.levels.includes(level)) return { outcome: 'refused', code: 'level', file: '' };
  if (st.state === 'notStarted') return level === 'off' ? { outcome: 'cleared', pending: null } : { outcome: 'pending', pending: level };
  const r = applied(dir, srv, level);
  if (r.refused) return { outcome: 'refused', ...r.refused };
  return { outcome: r.changes ? 'applied' : 'already', pending: null };
}

// A waiting level, once the files are there. clear: pyide-server.json no longer needs it. A refused one stays, so it goes
// through by itself when the owner has fixed the file.
function settle(dir, srv) {
  const level = pendingOf(srv);
  if (!level || supportOf(srv) !== 'paper') return { outcome: 'dropped', clear: true };
  if (!fs.existsSync(path.join(dir, DEFAULTS))) return { outcome: 'waiting' };
  const r = applied(dir, srv, level);
  return r.refused ? { outcome: 'refused', level, ...r.refused } : { outcome: 'applied', level, clear: true };
}

module.exports = { DEFAULTS, BACKUP, LEVELS, wanted, levelsFor, supportOf, newServerLevel, status, planned, commit, assign, settle, edit, readBlock };
