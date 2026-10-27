// Java expressions for the JVM debugger's Evaluate, Watches, Set Value and breakpoint conditions: a parser for the
// part of Java an evaluation needs (names, fields, method calls, array elements, literals, operators, casts and
// assignment) and an interpreter that works on JDWP values through the debugger's context (debug-jvm.js). No code is
// compiled into the program; `new`, lambdas and instanceof are not supported.
//
// A value is {tag, v} with a JDWP tag: primitives 'B' 'C' 'S' 'I' 'J' (v a BigInt) 'F' 'D' 'Z', objects '[' 'L' 's'
// 't' 'g' 'l' 'c' with v the object id (0 for null). A string made here (a literal, a concatenation) is {tag: '$', text}
// until it has to exist in the program (a method argument, an assignment).

const PRIMITIVES = { boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };
const NUMERIC = new Set(['B', 'C', 'S', 'I', 'J', 'F', 'D']);
const isPrimitive = (v) => v.tag in TAG_NAMES;
const TAG_NAMES = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double' };
const isString = (v) => v.tag === '$' || v.tag === 's';
const isNull = (v) => !isPrimitive(v) && v.tag !== '$' && !v.v;

class EvalError extends Error {}
const fail = (msg) => { throw new EvalError(msg); };

// ---------- tokens ----------
const OPS = ['>>>=', '<<=', '>>=', '>>>', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=',
  '(', ')', '[', ']', '.', ',', '?', ':', '!', '~', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^', '='];
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ', '"': '"', "'": "'", '\\': '\\' };

function tokenize(src) {
  const out = [];
  let i = 0;
  const unescape = (quote) => {
    let text = '';
    i++;
    for (;;) {
      if (i >= src.length) fail('Unterminated literal');
      const c = src[i];
      if (c === quote) { i++; return text; }
      if (c !== '\\') { text += c; i++; continue; }
      const n = src[i + 1];
      if (n === 'u') {
        const hex = /^u+([0-9a-fA-F]{4})/.exec(src.slice(i + 1));
        if (!hex) fail('Bad escape');
        text += String.fromCharCode(parseInt(hex[1], 16));
        i += 1 + hex[0].length;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1))[0];
        text += String.fromCharCode(parseInt(oct, 8));
        i += 1 + oct.length;
      } else if (Object.hasOwn(ESCAPES, n)) {
        text += ESCAPES[n];
        i += 2;
      } else fail('Bad escape');
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?)([lLfFdD])?/.exec(src.slice(i));
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      out.push({ k: 'num', text: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_$][\p{L}\p{M}\p{N}_$]*/u.exec(src.slice(i));
    if (id) { out.push({ k: 'id', text: id[0] }); i += id[0].length; continue; }
    if (c === '"') { out.push({ k: 'str', text: unescape('"') }); continue; }
    if (c === "'") {
      const text = unescape("'");
      if (text.length !== 1) fail('Bad character literal');
      out.push({ k: 'char', text });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) fail(`Unexpected '${c}'`);
    out.push({ k: 'op', text: op });
    i += op.length;
  }
  out.push({ k: 'end', text: '' });
  return out;
}

// ---------- parser ----------
const BINARY = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%']];
const COMPOUND = { '+=': '+', '-=': '-', '*=': '*', '/=': '/' };

function parse(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const is = (text, o = 0) => peek(o).k === 'op' && peek(o).text === text;
  const take = (text) => { if (!is(text)) fail(`Expected '${text}'`); p++; };
  const word = (text, o = 0) => peek(o).k === 'id' && peek(o).text === text;

  function expr() {
    const target = ternary();
    if (is('=') || Object.hasOwn(COMPOUND, peek().text) && peek().k === 'op') {
      const op = peek().text;
      p++;
      if (!['name', 'field', 'index'].includes(target.t)) fail('Cannot assign to this expression');
      const value = expr();
      return { t: 'assign', target, value: op === '=' ? value : { t: 'binary', op: COMPOUND[op], l: target, r: value } };
    }
    return target;
  }
  function ternary() {
    const c = binary(0);
    if (!is('?')) return c;
    p++;
    const a = expr();
    take(':');
    return { t: 'cond', c, a, b: ternary() };
  }
  function binary(level) {
    if (level === BINARY.length) return unary();
    let l = binary(level + 1);
    while (peek().k === 'op' && BINARY[level].includes(peek().text)) {
      const op = peek().text;
      p++;
      l = { t: 'binary', op, l, r: binary(level + 1) };
    }
    if (level === 6 && word('instanceof')) fail("'instanceof' is not supported");
    return l;
  }
  // (int) x, (String) o: a primitive type in parentheses, or a dotted name followed by something that starts an operand.
  function castAhead() {
    if (!is('(') || peek(1).k !== 'id') return null;
    let o = 1;
    const parts = [peek(1).text];
    while (is('.', o + 1) && peek(o + 2).k === 'id') { parts.push(peek(o + 2).text); o += 2; }
    while (is('[', o + 1) && is(']', o + 2)) { parts[parts.length - 1] += '[]'; o += 2; }
    if (!is(')', o + 1)) return null;
    const name = parts.join('.');
    const next = peek(o + 2);
    const primitive = Object.hasOwn(PRIMITIVES, name);
    const operand = ['id', 'num', 'str', 'char'].includes(next.k) || (next.k === 'op' && ['(', '!', '~'].includes(next.text))
      || (primitive && next.k === 'op' && ['+', '-'].includes(next.text));
    if (!operand) return null;
    return { name, skip: o + 2 };
  }
  function unary() {
    const t = peek();
    if (t.k === 'op' && ['!', '-', '+', '~'].includes(t.text)) { p++; return { t: 'unary', op: t.text, e: unary() }; }
    const cast = castAhead();
    if (cast) { p += cast.skip; return { t: 'cast', type: cast.name, e: unary() }; }
    return postfix(primary());
  }
  function args() {
    take('(');
    const list = [];
    if (!is(')')) for (;;) { list.push(expr()); if (is(')')) break; take(','); }
    take(')');
    return list;
  }
  function postfix(e) {
    for (;;) {
      if (is('.')) {
        p++;
        const t = peek();
        if (t.k !== 'id') fail('Expected a name after .');
        p++;
        if (t.text === 'class') fail("'.class' is not supported");
        e = is('(') ? { t: 'call', obj: e, name: t.text, args: args() } : { t: 'field', obj: e, name: t.text };
      } else if (is('[')) {
        p++;
        const index = expr();
        take(']');
        e = { t: 'index', obj: e, index };
      } else return e;
    }
  }
  function primary() {
    const t = peek();
    p++;
    if (t.k === 'num') return { t: 'lit', value: numberLiteral(t.text) };
    if (t.k === 'str') return { t: 'lit', value: { tag: '$', text: t.text } };
    if (t.k === 'char') return { t: 'lit', value: { tag: 'C', v: t.text.charCodeAt(0) } };
    if (t.k === 'op' && t.text === '(') { const e = expr(); take(')'); return e; }
    if (t.k === 'id') {
      if (t.text === 'true' || t.text === 'false') return { t: 'lit', value: { tag: 'Z', v: t.text === 'true' } };
      if (t.text === 'null') return { t: 'lit', value: { tag: 'L', v: 0 } };
      if (t.text === 'this') return { t: 'this' };
      if (t.text === 'new') fail("'new' is not supported");
      if (t.text === 'super') fail("'super' is not supported");
      return is('(') ? { t: 'call', obj: null, name: t.text, args: args() } : { t: 'name', name: t.text };
    }
    fail(t.k === 'end' ? 'Unexpected end of expression' : `Unexpected '${t.text}'`);
  }

  const e = expr();
  if (peek().k !== 'end') fail(`Unexpected '${peek().text}'`);
  return e;
}

function numberLiteral(text) {
  const suffix = /[lLfFdD]$/.test(text) && !/^0[xX]/.test(text) ? text.slice(-1).toLowerCase() : /[lL]$/.test(text) ? 'l' : '';
  const body = (suffix ? text.slice(0, -1) : text).replace(/_/g, '');
  if (suffix === 'l') return { tag: 'J', v: BigInt.asIntN(64, BigInt(body)) };
  if (suffix === 'f') return { tag: 'F', v: Math.fround(Number(body)) };
  if (suffix === 'd' || /[.eE]/.test(body) && !/^0[xX]/.test(body)) return { tag: 'D', v: Number(body) };
  const n = Number(body);
  if (!Number.isFinite(n) || n > 0xffffffff) fail(`Integer number too large: ${text}`);
  return { tag: 'I', v: n | 0 };
}

// ---------- values ----------
const num = (v) => (v.tag === 'J' ? Number(v.v) : v.tag === 'Z' ? fail('Not a number') : v.v);
const big = (v) => (v.tag === 'J' ? v.v : BigInt(Math.trunc(num(v))));
// Java's binary numeric promotion: double, float, long, else int.
const promoted = (a, b) => (a.tag === 'D' || b.tag === 'D' ? 'D' : a.tag === 'F' || b.tag === 'F' ? 'F' : a.tag === 'J' || b.tag === 'J' ? 'J' : 'I');

function convert(v, tag) {
  if (v.tag === tag) return v;
  if (tag === 'Z' || v.tag === 'Z') fail(`Incompatible types: ${TAG_NAMES[v.tag] || 'object'} cannot be converted to ${TAG_NAMES[tag]}`);
  if (tag === 'J') return { tag, v: BigInt.asIntN(64, big(v)) };
  if (tag === 'D') return { tag, v: num(v) };
  if (tag === 'F') return { tag, v: Math.fround(num(v)) };
  const n = v.tag === 'J' ? Number(BigInt.asIntN(32, v.v)) : Number.isFinite(num(v)) ? Math.trunc(num(v)) : 0;
  const i = n | 0;
  if (tag === 'I') return { tag, v: i };
  if (tag === 'S') return { tag, v: (i << 16) >> 16 };
  if (tag === 'B') return { tag, v: (i << 24) >> 24 };
  return { tag: 'C', v: i & 0xffff };
}

// Java's String.valueOf for a primitive.
function primitiveText(v) {
  if (v.tag === 'Z') return String(v.v);
  if (v.tag === 'C') return String.fromCharCode(v.v);
  if (v.tag === 'J') return v.v.toString();
  if (v.tag === 'D' || v.tag === 'F') {
    const x = v.v;
    if (Number.isNaN(x)) return 'NaN';
    if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
    if (Object.is(x, -0)) return '-0.0';
    const a = Math.abs(x);
    if (a !== 0 && (a < 1e-3 || a >= 1e7)) {
      const [m, e] = (v.tag === 'F' ? Number(x.toPrecision(8)) : x).toExponential().split('e');
      return `${m.includes('.') ? m : `${m}.0`}E${Number(e)}`;
    }
    const s = String(v.tag === 'F' ? Number(x.toPrecision(8)) : x);
    return s.includes('.') ? s : `${s}.0`;
  }
  return String(v.v);
}

// ---------- interpreter ----------
// ctx: the JVM debugger's view of the frame the expression runs in. Every method may be async.
//   local(name) -> value | undefined; setLocal(name, value) -> value
//   thisObject() -> value | null; field(objValue, name) -> value | undefined; setField(objValue, name, value)
//   staticField(type, name) -> value | undefined; setStaticField(type, name, value); type(qualifiedName) -> type | null
//   frameType() -> the frame's class (statics and unqualified calls); call(target, name, args, isStatic) -> value
//   arrayLength(arr); element(arr, i); setElement(arr, i, value); unbox(value) -> primitive | null; box(primitive)
//   text(value) -> JS string (String.valueOf, toString() on objects)
async function evaluate(node, ctx) {
  const run = (n) => evaluate(n, ctx);
  switch (node.t) {
    case 'lit': return node.value;
    case 'this': {
      const self = await ctx.thisObject();
      if (!self) fail("'this' is not available in a static context");
      return self;
    }
    case 'name': return resolveName(node.name, ctx);
    case 'field': return member(await run(node.obj), node.name, ctx);
    case 'call': {
      const args = [];
      for (const a of node.args) args.push(value(await run(a)));
      if (!node.obj) {
        const self = await ctx.thisObject();
        return self ? ctx.call(self, node.name, args, false, true) : ctx.call(await ctx.frameType(), node.name, args, true);
      }
      const target = await run(node.obj);
      if (target.kind === 'type') return ctx.call(target, node.name, args, true);
      if (target.kind === 'package') fail(`Cannot find symbol ${target.name}`);
      if (isPrimitive(target)) fail(`${TAG_NAMES[target.tag]} cannot be dereferenced`);
      if (isNull(target)) fail('NullPointerException');
      return ctx.call(target, node.name, args, false);
    }
    case 'index': {
      const arr = value(await run(node.obj));
      const i = await primitive(value(await run(node.index)), ctx);
      if (arr.tag !== '[') fail(isNull(arr) ? 'NullPointerException' : 'Array type expected');
      if (!NUMERIC.has(i.tag) || i.tag === 'J' || i.tag === 'F' || i.tag === 'D') fail('Array index must be an int');
      const len = await ctx.arrayLength(arr);
      if (i.v < 0 || i.v >= len) fail(`ArrayIndexOutOfBoundsException: Index ${i.v} out of bounds for length ${len}`);
      return ctx.element(arr, i.v);
    }
    case 'unary': {
      const v = await primitive(value(await run(node.e)), ctx);
      if (node.op === '!') { if (v.tag !== 'Z') fail("Bad operand type for '!'"); return { tag: 'Z', v: !v.v }; }
      if (!NUMERIC.has(v.tag)) fail(`Bad operand type for '${node.op}'`);
      const tag = promoted(v, { tag: 'I' });
      const x = convert(v, tag);
      if (node.op === '+') return x;
      if (node.op === '~') { if (tag !== 'I' && tag !== 'J') fail("Bad operand type for '~'"); return { tag, v: ~x.v }; }
      return tag === 'J' ? { tag, v: BigInt.asIntN(64, -x.v) } : tag === 'I' ? { tag, v: -x.v | 0 } : { tag, v: -x.v };
    }
    case 'cast': {
      const v = value(await run(node.e));
      if (!Object.hasOwn(PRIMITIVES, node.type)) return v;
      const p = await primitive(v, ctx);
      return convert(p, PRIMITIVES[node.type]);
    }
    case 'cond': {
      const c = await primitive(value(await run(node.c)), ctx);
      if (c.tag !== 'Z') fail('Incompatible types: condition is not boolean');
      return run(c.v ? node.a : node.b);
    }
    case 'binary': return binaryOp(node, ctx);
    case 'assign': return assign(node.target, value(await run(node.value)), ctx);
    default: fail('Unsupported expression');
  }
}

// A name is a local, a field of this, a static field of the frame's class, a type or the start of a package name.
async function resolveName(name, ctx) {
  const local = await ctx.local(name);
  if (local) return local;
  const self = await ctx.thisObject();
  if (self) { const f = await ctx.field(self, name); if (f) return f; }
  const own = await ctx.frameType();
  if (own) { const f = await ctx.staticField(own, name); if (f) return f; }
  const type = await ctx.type(name);
  if (type) return type;
  return { kind: 'package', name };
}

async function member(target, name, ctx) {
  if (target.kind === 'package') {
    const qualified = `${target.name}.${name}`;
    return (await ctx.type(qualified)) || { kind: 'package', name: qualified };
  }
  if (target.kind === 'type') {
    const f = await ctx.staticField(target, name);
    if (f) return f;
    const nested = await ctx.type(`${target.name}$${name}`);
    if (nested) return nested;
    fail(`Cannot find symbol ${name} in ${target.name}`);
  }
  if (isPrimitive(target) || target.tag === '$') fail(`${TAG_NAMES[target.tag] || 'String'} cannot be dereferenced`);
  if (isNull(target)) fail('NullPointerException');
  if (target.tag === '[' && name === 'length') return { tag: 'I', v: await ctx.arrayLength(target) };
  const f = await ctx.field(target, name);
  if (!f) fail(`Cannot find symbol ${name}`);
  return f;
}

// A type or package name where a value is needed.
function value(v) {
  if (v.kind === 'type') fail(`Expression expected, but ${v.name} is a type`);
  if (v.kind === 'package') fail(`Cannot find symbol ${v.name}`);
  return v;
}

// Unboxes Integer, Boolean... for arithmetic; other objects stay as they are.
async function primitive(v, ctx) {
  if (isPrimitive(v) || v.tag === '$' || isNull(v)) return v;
  return (await ctx.unbox(v)) || v;
}

async function binaryOp({ op, l, r }, ctx) {
  const lv = value(await evaluate(l, ctx));
  if (op === '&&' || op === '||') {
    const a = await primitive(lv, ctx);
    if (a.tag !== 'Z') fail(`Bad operand types for '${op}'`);
    if (op === '&&' ? !a.v : a.v) return a;
    const b = await primitive(value(await evaluate(r, ctx)), ctx);
    if (b.tag !== 'Z') fail(`Bad operand types for '${op}'`);
    return b;
  }
  const rv = value(await evaluate(r, ctx));
  if (op === '+' && (isString(lv) || isString(rv))) {
    return { tag: '$', text: (await ctx.text(lv)) + (await ctx.text(rv)) };
  }
  if (op === '==' || op === '!=') {
    const same = await equal(lv, rv, ctx);
    return { tag: 'Z', v: op === '==' ? same : !same };
  }
  const a = await primitive(lv, ctx);
  const b = await primitive(rv, ctx);
  if (a.tag === 'Z' && b.tag === 'Z' && ['&', '|', '^'].includes(op)) {
    return { tag: 'Z', v: op === '&' ? a.v && b.v : op === '|' ? a.v || b.v : a.v !== b.v };
  }
  if (!NUMERIC.has(a.tag) || !NUMERIC.has(b.tag)) fail(`Bad operand types for '${op}'`);
  if (['<', '>', '<=', '>='].includes(op)) {
    const tag = promoted(a, b);
    const x = tag === 'J' ? big(a) : num(a);
    const y = tag === 'J' ? big(b) : num(b);
    return { tag: 'Z', v: op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y };
  }
  if (['<<', '>>', '>>>'].includes(op)) {
    const tag = promoted(a, { tag: 'I' });
    if (tag !== 'I' && tag !== 'J') fail(`Bad operand types for '${op}'`);
    const x = convert(a, tag);
    if (tag === 'J') {
      const s = BigInt(Number(big(b)) & 63);
      return { tag, v: BigInt.asIntN(64, op === '<<' ? x.v << s : op === '>>' ? x.v >> s : BigInt.asUintN(64, x.v) >> s) };
    }
    const s = Number(big(b)) & 31;
    return { tag, v: op === '<<' ? x.v << s : op === '>>' ? x.v >> s : (x.v >>> s) | 0 };
  }
  const tag = promoted(a, b);
  const x = convert(a, tag);
  const y = convert(b, tag);
  if (tag === 'J') {
    if ((op === '/' || op === '%') && y.v === 0n) fail('ArithmeticException: / by zero');
    const v = { '+': x.v + y.v, '-': x.v - y.v, '*': x.v * y.v, '/': y.v ? x.v / y.v : 0n, '%': y.v ? x.v % y.v : 0n,
      '&': x.v & y.v, '|': x.v | y.v, '^': x.v ^ y.v }[op];
    return { tag, v: BigInt.asIntN(64, v) };
  }
  if (tag === 'I') {
    if ((op === '/' || op === '%') && y.v === 0) fail('ArithmeticException: / by zero');
    const v = { '+': x.v + y.v, '-': x.v - y.v, '*': Math.imul(x.v, y.v), '/': Math.trunc(x.v / y.v), '%': x.v % y.v,
      '&': x.v & y.v, '|': x.v | y.v, '^': x.v ^ y.v }[op];
    return { tag, v: v | 0 };
  }
  if (['&', '|', '^'].includes(op)) fail(`Bad operand types for '${op}'`);
  const v = { '+': x.v + y.v, '-': x.v - y.v, '*': x.v * y.v, '/': x.v / y.v, '%': x.v % y.v }[op];
  return { tag, v: tag === 'F' ? Math.fround(v) : v };
}

// Primitives (and boxed values next to a primitive) compare by value; objects by identity, except that a string made
// here compares by its text, since it does not exist in the program.
async function equal(a, b, ctx) {
  if (a.tag === '$' || b.tag === '$') {
    if (isNull(a) || isNull(b)) return false;
    return isString(a) && isString(b) && (await ctx.text(a)) === (await ctx.text(b));
  }
  if (isPrimitive(a) || isPrimitive(b)) {
    const x = await primitive(a, ctx);
    const y = await primitive(b, ctx);
    if (x.tag === 'Z' || y.tag === 'Z') {
      if (x.tag !== y.tag) fail("Incomparable types for '=='");
      return x.v === y.v;
    }
    if (!NUMERIC.has(x.tag) || !NUMERIC.has(y.tag)) fail("Incomparable types for '=='");
    const tag = promoted(x, y);
    return tag === 'J' ? big(x) === big(y) : num(x) === num(y);
  }
  return a.v === b.v;
}

async function assign(target, v, ctx) {
  if (target.t === 'name') {
    if (await ctx.local(target.name)) return ctx.setLocal(target.name, v);
    const self = await ctx.thisObject();
    if (self && (await ctx.field(self, target.name))) return ctx.setField(self, target.name, v);
    const own = await ctx.frameType();
    if (own && (await ctx.staticField(own, target.name))) return ctx.setStaticField(own, target.name, v);
    fail(`Cannot find symbol ${target.name}`);
  }
  if (target.t === 'field') {
    const obj = await evaluate(target.obj, ctx);
    if (obj.kind === 'type') return ctx.setStaticField(obj, target.name, v);
    if (obj.kind === 'package' || isPrimitive(obj) || obj.tag === '$') fail('Cannot assign to this expression');
    if (isNull(obj)) fail('NullPointerException');
    return ctx.setField(obj, target.name, v);
  }
  const arr = value(await evaluate(target.obj, ctx));
  const i = await primitive(value(await evaluate(target.index, ctx)), ctx);
  if (arr.tag !== '[') fail(isNull(arr) ? 'NullPointerException' : 'Array type expected');
  const len = await ctx.arrayLength(arr);
  if (i.v < 0 || i.v >= len) fail(`ArrayIndexOutOfBoundsException: Index ${i.v} out of bounds for length ${len}`);
  return ctx.setElement(arr, i.v, v);
}

// The value of a whole expression: a type or package name alone is not one.
const run = async (src, ctx) => value(await evaluate(parse(src), ctx));

module.exports = { parse, evaluate, run, convert, primitiveText, isPrimitive, isString, isNull, EvalError, PRIMITIVES, TAG_NAMES };
module.exports.register = () => {};
