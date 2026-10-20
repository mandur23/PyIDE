// The MongoDB shell dialect of the query console, parsed without running any code: `show dbs`, `use x`, and
// db[.getSiblingDB('x')].<collection>.<method>(args)[.<method>(args)...] where every argument is a literal in shell
// syntax (relaxed JSON: unquoted keys, single quotes, trailing commas, regex literals, ObjectId('..'), ISODate('..'),
// NumberLong(..), ...). Helper calls become ShellValue markers that the MongoDB kind turns into BSON values; dates and
// regexes become Date and RegExp. Values are plain data, so nothing a user types can execute in the main process.

class ShellValue {
  constructor(type, value) { this.type = type; this.value = value; }
}

class ShellSyntaxError extends Error {}

const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ',', ':', '.', ';', '-', '+']);
// After these tokens a `/` starts a regex literal rather than a division.
const REGEX_AFTER = new Set([undefined, '(', ',', ':', '[', '{', ';']);

function position(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const fail = (msg, at = i) => { throw new ShellSyntaxError(`${msg} at ${position(text, at)}`); };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); if (e < 0) fail('Unterminated comment'); i = e + 2; continue; }
    const start = i;
    if (ch === '"' || ch === "'" || ch === '`') {
      let out = '';
      i++;
      for (;;) {
        if (i >= text.length) fail('Unterminated string', start);
        const c = text[i];
        if (c === ch) { i++; break; }
        if (ch === '`' && c === '$' && text[i + 1] === '{') fail('Template expressions are not supported');
        if (c === '\n' && ch !== '`') fail('Unterminated string', start);
        if (c !== '\\') { out += c; i++; continue; }
        const n = text[i + 1];
        i += 2;
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (n in simple) out += simple[n];
        else if (n === 'x') { const h = text.slice(i, i + 2); if (!/^[0-9a-f]{2}$/i.test(h)) fail('Bad \\x escape'); out += String.fromCharCode(parseInt(h, 16)); i += 2; } else if (n === 'u') {
          const m = text.slice(i).match(/^\{([0-9a-f]{1,6})\}|^([0-9a-f]{4})/i);
          if (!m) fail('Bad \\u escape');
          out += String.fromCodePoint(parseInt(m[1] || m[2], 16));
          i += m[0].length;
        } else if (n === '\r' || n === '\n') { if (n === '\r' && text[i] === '\n') i++; } else out += n;
      }
      tokens.push({ t: 'str', v: out, at: start });
      continue;
    }
    const prev = tokens[tokens.length - 1];
    if (ch === '/' && REGEX_AFTER.has(prev?.t === 'p' ? prev.v : prev ? 'value' : undefined)) {
      let j = i + 1;
      let inClass = false;
      for (;;) {
        if (j >= text.length || text[j] === '\n') fail('Unterminated regular expression', start);
        const c = text[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      const source = text.slice(i + 1, j);
      const flags = text.slice(j + 1).match(/^[a-z]*/)[0];
      try { tokens.push({ t: 're', v: new RegExp(source, flags), at: start }); } catch (err) { fail(err.message, start); }
      i = j + 1 + flags.length;
      continue;
    }
    const num = text.slice(i).match(/^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/);
    if (num && !(ch === '.' && !/\d/.test(text[i + 1] || ''))) {
      tokens.push({ t: 'num', v: Number(num[0]), raw: num[0], at: start });
      i += num[0].length;
      continue;
    }
    const id = text.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (id) { tokens.push({ t: 'id', v: id[0], at: start }); i += id[0].length; continue; }
    if (PUNCT.has(ch)) { tokens.push({ t: 'p', v: ch, at: start }); i++; continue; }
    fail(`Unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

const HEX24 = /^[0-9a-fA-F]{24}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

function parser(text) {
  const tokens = tokenize(text);
  let k = 0;
  const peek = (o = 0) => tokens[k + o];
  const at = (tok) => (tok ? position(text, tok.at) : 'the end');
  const fail = (msg, tok = peek()) => { throw new ShellSyntaxError(`${msg} at ${at(tok)}`); };
  const describe = (tok) => (tok ? (tok.t === 'str' ? 'string' : JSON.stringify(String(tok.v))) : 'end of input');
  const isP = (v, o = 0) => peek(o)?.t === 'p' && peek(o).v === v;
  const expect = (v) => { if (!isP(v)) fail(`Expected ${JSON.stringify(v)} but found ${describe(peek())}`); return tokens[k++]; };
  const ident = () => { if (peek()?.t !== 'id') fail(`Expected a name but found ${describe(peek())}`); return tokens[k++].v; };

  function args() {
    expect('(');
    const out = [];
    while (!isP(')')) {
      out.push(value());
      if (!isP(',')) break;
      k++;
    }
    expect(')');
    return out;
  }

  // A helper such as ObjectId('...'), with `new` allowed in front.
  function helper(name, tok) {
    const a = isP('(') ? args() : null;
    const str = (i = 0) => {
      if (typeof a?.[i] !== 'string') fail(`${name}() expects a string`, tok);
      return a[i];
    };
    const numeric = () => {
      const v = a?.[0];
      if (typeof v === 'number' && Number.isInteger(v)) return String(v);
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return v.trim();
      return fail(`${name}() expects an integer`, tok);
    };
    switch (name) {
      case 'ObjectId': case 'ObjectID':
        if (!a?.length) return new ShellValue('ObjectId', null);
        if (!HEX24.test(str())) fail('ObjectId() expects 24 hexadecimal characters', tok);
        return new ShellValue('ObjectId', a[0].toLowerCase());
      case 'ISODate': case 'Date': {
        if (!a?.length) return new Date();
        const d = new Date(typeof a[0] === 'number' ? a[0] : str());
        if (Number.isNaN(d.getTime())) fail(`Invalid date ${JSON.stringify(a[0])}`, tok);
        return d;
      }
      case 'NumberLong': case 'Long': return new ShellValue('Long', numeric());
      case 'NumberInt': case 'Int32': {
        const n = Number(numeric());
        if (n < -2147483648 || n > 2147483647) fail('NumberInt() is out of range', tok);
        return new ShellValue('Int32', n);
      }
      case 'NumberDecimal': case 'Decimal128':
        if (typeof a?.[0] === 'number') return new ShellValue('Decimal128', String(a[0]));
        return new ShellValue('Decimal128', str());
      case 'Double': if (typeof a?.[0] !== 'number') fail('Double() expects a number', tok); return new ShellValue('Double', a[0]);
      case 'UUID':
        if (!a?.length) return new ShellValue('UUID', null);
        if (!UUID_RE.test(str())) fail('UUID() expects a UUID string', tok);
        return new ShellValue('UUID', a[0].replace(/-/g, '').toLowerCase());
      case 'Timestamp': {
        const o = a?.[0] && typeof a[0] === 'object' ? a[0] : { t: a?.[0] ?? 0, i: a?.[1] ?? 0 };
        if (!Number.isInteger(o.t) || !Number.isInteger(o.i)) fail('Timestamp() expects integers t and i', tok);
        return new ShellValue('Timestamp', { t: o.t, i: o.i });
      }
      case 'BinData':
        if (!Number.isInteger(a?.[0]) || typeof a?.[1] !== 'string') fail('BinData() expects a subtype and a base64 string', tok);
        return new ShellValue('Binary', { subType: a[0], base64: a[1] });
      case 'MinKey': case 'MaxKey': return new ShellValue(name, null);
      case 'RegExp': return (() => { try { return new RegExp(str(), a[1] === undefined ? '' : str(1)); } catch (err) { return fail(err.message, tok); } })();
      default: return fail(`Unknown function ${name}()`, tok);
    }
  }

  function value() {
    const tok = peek();
    if (!tok) fail('Unexpected end of input');
    if (tok.t === 'str' || tok.t === 're') { k++; return tok.v; }
    if (tok.t === 'num') { k++; return tok.v; }
    if (tok.t === 'p' && (tok.v === '-' || tok.v === '+')) {
      k++;
      const n = peek();
      if (n?.t === 'num' || (n?.t === 'id' && n.v === 'Infinity')) { k++; const v = n.t === 'num' ? n.v : Infinity; return tok.v === '-' ? -v : v; }
      return fail(`Expected a number after ${tok.v}`, n);
    }
    if (tok.t === 'p' && tok.v === '{') {
      k++;
      const obj = {};
      while (!isP('}')) {
        const key = peek();
        if (key?.t === 'id' || key?.t === 'str') k++;
        else if (key?.t === 'num') { k++; key.v = key.raw; } else fail(`Expected a field name but found ${describe(key)}`, key);
        expect(':');
        Object.defineProperty(obj, String(key.v), { value: value(), enumerable: true, writable: true, configurable: true });
        if (!isP(',')) break;
        k++;
      }
      expect('}');
      return obj;
    }
    if (tok.t === 'p' && tok.v === '[') {
      k++;
      const arr = [];
      while (!isP(']')) {
        arr.push(value());
        if (!isP(',')) break;
        k++;
      }
      expect(']');
      return arr;
    }
    if (tok.t === 'id') {
      k++;
      const words = { true: true, false: false, null: null, undefined: null, Infinity: Infinity, NaN: NaN };
      if (tok.v in words && !isP('(')) return words[tok.v];
      if (tok.v === 'new') { const name = ident(); return helper(name, tok); }
      if (tok.v === 'MinKey' || tok.v === 'MaxKey' || isP('(')) return helper(tok.v, tok);
      return fail(`Unknown name ${tok.v}`, tok);
    }
    return fail(`Unexpected ${describe(tok)}`, tok);
  }

  return { tokens, peek, isP, expect, ident, args, value, fail, done: () => k >= tokens.length, next: () => tokens[k++] };
}

// One console statement -> {type: 'show', what} | {type: 'use', db} | {type: 'call', db, collection, method, args, chain}.
// db is null for the console's current database; collection is null for database methods (db.runCommand(...)).
function parseCommand(input) {
  const text = input.trim().replace(/;\s*$/, '');
  const show = text.match(/^show\s+([A-Za-z]+)$/);
  if (show) return { type: 'show', what: show[1].toLowerCase() };
  const use = text.match(/^use\s+([^\s;]+)$/);
  if (use) return { type: 'use', db: use[1] };
  if (!text) throw new ShellSyntaxError('Empty statement');
  const p = parser(text);
  const first = p.peek();
  if (first?.t !== 'id' || first.v !== 'db') p.fail('Statements start with db, show or use', first);
  p.next();
  let db = null;
  let collection = null;
  const names = [];
  // Member names up to the first call: db.a.b.find() is collection "a.b"; db.getSiblingDB('x') and
  // db.getCollection('c') / db['c'] set the database and the collection explicitly.
  for (;;) {
    if (p.isP('[')) {
      p.next();
      const tok = p.peek();
      if (tok?.t !== 'str') p.fail('Expected a collection name string', tok);
      p.next();
      p.expect(']');
      names.push(tok.v);
      continue;
    }
    if (!p.isP('.')) break;
    p.next();
    const name = p.ident();
    if (!p.isP('(')) { names.push(name); continue; }
    if ((name === 'getSiblingDB' || name === 'getCollection') && !collection && !names.length) {
      const tok = p.peek(1);
      const a = p.args();
      if (a.length !== 1 || typeof a[0] !== 'string' || !a[0]) p.fail(`${name}() expects a name string`, tok);
      if (name === 'getSiblingDB') db = a[0]; else collection = a[0];
      continue;
    }
    if (names.length) collection = collection ? `${collection}.${names.join('.')}` : names.join('.');
    const call = { method: name, args: p.args() };
    const chain = [];
    while (p.isP('.')) {
      p.next();
      const m = p.ident();
      chain.push({ method: m, args: p.args() });
    }
    if (!p.done()) p.fail(`Unexpected ${JSON.stringify(String(p.peek().v))}`);
    return { type: 'call', db, collection, method: call.method, args: call.args, chain };
  }
  return p.fail('Expected a method call such as db.collection.find()');
}

// Parses one value in shell syntax ("{a: 1}", "ObjectId('...')").
function parseValue(text) {
  const p = parser(text);
  const v = p.value();
  if (!p.done()) p.fail('Unexpected input after the value');
  return v;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
// The console text that shows a collection's documents (Open Data).
const openDataCommand = (db, collection) => `use ${db}\n${IDENT.test(collection) ? `db.${collection}` : `db.getCollection(${JSON.stringify(collection)})`}.find({}).limit(200)`;

module.exports = { parseCommand, parseValue, tokenize, openDataCommand, ShellValue, ShellSyntaxError };
