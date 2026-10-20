// The Redis console: one command per line in redis-cli syntax, replies shaped into tables, and the key tree grouped by
// the `:` separator. Pure functions; main/db/kinds/redis.js does the I/O.

class RedisSyntaxError extends Error {}

// redis-cli's argument splitting: whitespace-separated words, "double quotes" with \n \r \t \b \a \xHH escapes,
// 'single quotes' with only \' escaped. A closing quote must end the word.
function splitArgs(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let word = '';
    let quote = null;
    for (;;) {
      if (i >= n) {
        if (quote) throw new RedisSyntaxError('Unbalanced quotes');
        break;
      }
      const c = line[i];
      if (quote === '"') {
        if (c === '\\' && line[i + 1] === 'x' && /^[0-9a-f]{2}$/i.test(line.slice(i + 2, i + 4))) { word += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16)); i += 4; continue; }
        if (c === '\\' && i + 1 < n) {
          const e = line[i + 1];
          word += { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' }[e] ?? e;
          i += 2;
          continue;
        }
        if (c === '"') {
          if (i + 1 < n && !/\s/.test(line[i + 1])) throw new RedisSyntaxError('A closing quote must be followed by a space');
          quote = null;
          i++;
          break;
        }
        word += c;
        i++;
      } else if (quote === "'") {
        if (c === '\\' && line[i + 1] === "'") { word += "'"; i += 2; continue; }
        if (c === "'") {
          if (i + 1 < n && !/\s/.test(line[i + 1])) throw new RedisSyntaxError('A closing quote must be followed by a space');
          quote = null;
          i++;
          break;
        }
        word += c;
        i++;
      } else {
        if (/\s/.test(c)) break;
        if ((c === '"' || c === "'") && word === '') { quote = c; i++; continue; }
        word += c;
        i++;
      }
    }
    out.push(word);
  }
  return out;
}

// A word as redis-cli would read it back.
const quoteArg = (s) => (/^[^\s"'\\]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`);

// The console command that shows a key's value by its type (Open Data). db is the database index.
function openDataCommand(db, key, type) {
  const k = quoteArg(key);
  const cmd = {
    string: `GET ${k}`, hash: `HGETALL ${k}`, list: `LRANGE ${k} 0 199`, set: `SMEMBERS ${k}`,
    zset: `ZRANGE ${k} 0 199 WITHSCORES`, stream: `XRANGE ${k} - + COUNT 200`,
  }[type] || `TYPE ${k}`;
  return `SELECT ${db}\n${cmd}`;
}

const text = (v) => {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (Array.isArray(v)) return JSON.stringify(v.map(text));
  return typeof v === 'number' ? v : String(v);
};
const pairs = (arr) => {
  const rows = [];
  for (let i = 0; i + 1 < arr.length; i += 2) rows.push([text(arr[i]), text(arr[i + 1])]);
  return rows;
};
const numeric = (s) => (typeof s === 'string' && /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : s);

// Stream entries [{id, kv: [field, value, ...], lead: [...]}] as rows of lead, id and one column per field.
function streamTable(entries) {
  const fields = [];
  const seen = new Set();
  for (const { kv } of entries) for (let i = 0; i < (kv?.length || 0); i += 2) { const f = text(kv[i]); if (!seen.has(f)) { seen.add(f); fields.push(f); } }
  const rows = entries.map(({ id, kv, lead = [] }) => {
    const m = new Map(pairs(kv || []));
    return [...lead, text(id), ...fields.map((f) => (m.has(f) ? m.get(f) : null))];
  });
  return { fields, rows };
}

// A reply as {columns, rows} or {message}. Arrays become tables shaped by the command: field/value pairs for hashes,
// member/score for sorted sets with WITHSCORES, one row per entry for streams, and one value per row otherwise.
function formatReply(args, reply) {
  const cmd = String(args[0] || '').toUpperCase();
  const has = (word) => args.slice(1).some((a) => String(a).toUpperCase() === word);
  const table = (names, rows) => ({ columns: names.map((name) => ({ name, type: '' })), rows });
  if (reply === null || reply === undefined) return { message: '(nil)' };
  if (typeof reply === 'number') return { message: `(integer) ${reply}` };
  if (Buffer.isBuffer(reply)) reply = reply.toString('utf8');
  if (typeof reply === 'string') {
    if (cmd === 'INFO' || cmd === 'CLIENT' && /^LIST$/i.test(args[1] || '')) {
      const rows = reply.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes(':')).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), numeric(l.slice(i + 1))]; });
      if (rows.length) return table(['name', 'value'], rows);
    }
    if (cmd === 'GET' || cmd === 'GETDEL' || cmd === 'GETEX' || cmd === 'GETRANGE' || cmd === 'HGET' || cmd === 'LINDEX' || cmd === 'ECHO' || cmd === 'DUMP' || /^[\s\S]*\n/.test(reply)) return table(['value'], [[reply]]);
    return { message: reply };
  }
  if (!Array.isArray(reply)) return { message: String(reply) };
  if (cmd === 'HGETALL' || cmd === 'CONFIG' || (cmd === 'HRANDFIELD' && has('WITHVALUES'))) return table(cmd === 'CONFIG' ? ['name', 'value'] : ['field', 'value'], pairs(reply));
  if (/^Z(REV)?RANGE(BYSCORE|BYLEX)?$|^ZRANDMEMBER$|^ZPOP(MIN|MAX)$|^Z(UNION|INTER|DIFF)$/.test(cmd) && (has('WITHSCORES') || /^ZPOP/.test(cmd))) {
    return table(['member', 'score'], pairs(reply).map(([m, s]) => [m, numeric(s)]));
  }
  if (cmd === 'XRANGE' || cmd === 'XREVRANGE') {
    const { fields, rows } = streamTable(reply.map(([id, kv]) => ({ id, kv })));
    return table(['id', ...fields], rows);
  }
  if (cmd === 'XREAD' || cmd === 'XREADGROUP') {
    const { fields, rows } = streamTable(reply.flatMap(([stream, entries]) => (entries || []).map(([id, kv]) => ({ id, kv, lead: [text(stream)] }))));
    return table(['stream', 'id', ...fields], rows);
  }
  if (/^(SCAN|HSCAN|SSCAN|ZSCAN)$/.test(cmd) && reply.length === 2 && Array.isArray(reply[1])) {
    const shaped = cmd === 'HSCAN' ? table(['field', 'value'], pairs(reply[1]))
      : cmd === 'ZSCAN' ? table(['member', 'score'], pairs(reply[1]).map(([m, s]) => [m, numeric(s)]))
        : table(['value'], reply[1].map((v) => [text(v)]));
    return { ...shaped, cursor: text(reply[0]) };
  }
  return table(['value'], reply.map((v) => [text(v)]));
}

// Groups keys into a tree by `:`: a prefix shared by two or more keys becomes a group; keys keep their full name.
// keys: [{key, type}] -> nodes [{name, kind: 'group' | 'key', ...}].
function groupKeys(keys, db) {
  const build = (items, depth) => {
    const groups = new Map();
    const leaves = [];
    for (const it of items) {
      const parts = it.key.split(':');
      if (parts.length <= depth + 1) { leaves.push(it); continue; }
      const prefix = parts.slice(0, depth + 1).join(':');
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(it);
    }
    const nodes = [];
    for (const [prefix, members] of groups) {
      if (members.length < 2) { leaves.push(...members); continue; }
      nodes.push({ name: `${prefix}:`, kind: 'group', detail: `(${members.length})`, children: build(members, depth + 1) });
    }
    leaves.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    nodes.sort((a, b) => (a.name < b.name ? -1 : 1));
    return [...nodes, ...leaves.map((it) => ({ name: it.key, kind: 'key', detail: it.type, open: openDataCommand(db, it.key, it.type) }))];
  };
  return build(keys, 0);
}

module.exports = { splitArgs, quoteArg, formatReply, groupKeys, openDataCommand, RedisSyntaxError };
