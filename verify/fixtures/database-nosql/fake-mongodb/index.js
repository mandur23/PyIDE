// A stand-in for the `mongodb` npm package, installed into the test's driver directory so verify/database-nosql.mjs can
// drive the real MongoDB kind (shell parsing, BSON conversion, result shaping, tree) without a server. It keeps an
// in-memory store and logs every operation, with the BSON types of its arguments, to FAKE_MONGO_LOG.
const fs = require('fs');

const log = (entry) => { if (process.env.FAKE_MONGO_LOG) fs.appendFileSync(process.env.FAKE_MONGO_LOG, `${JSON.stringify(entry)}\n`); };

let seq = 0x100;
class ObjectId {
  constructor(hex) { this.hex = hex || `65a1b2c3d4e5f6071829${(seq++).toString(16).padStart(4, '0')}`; }
  get _bsontype() { return 'ObjectId'; }
  toHexString() { return this.hex; }
}
class Long {
  constructor(s) { this.s = String(s); }
  static fromString(s) { return new Long(s); }
  get _bsontype() { return 'Long'; }
  toString() { return this.s; }
  valueOf() { return Number(this.s); }
}
class Int32 { constructor(v) { this.v = v; } get _bsontype() { return 'Int32'; } valueOf() { return this.v; } }
class Double { constructor(v) { this.v = v; } get _bsontype() { return 'Double'; } valueOf() { return this.v; } }
class Decimal128 { constructor(s) { this.s = s; } static fromString(s) { return new Decimal128(s); } get _bsontype() { return 'Decimal128'; } toString() { return this.s; } }
class Binary { constructor(buf, sub = 0) { this.buffer = Buffer.from(buf); this.sub_type = sub; } get _bsontype() { return 'Binary'; } }
class UUID extends Binary {
  constructor(hex = '0123456789abcdef0123456789abcdef') { super(Buffer.from(hex, 'hex'), 4); this.hex = hex; }
  toUUID() { return { toHexString: () => this.hex.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') }; }
}
class Timestamp { constructor({ t, i }) { this.high = t; this.low = i; } get _bsontype() { return 'Timestamp'; } }
class MinKey { get _bsontype() { return 'MinKey'; } }
class MaxKey { get _bsontype() { return 'MaxKey'; } }

const typeOf = (v) => {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return 'Date';
  if (v instanceof RegExp) return `RegExp(${v.source}/${v.flags})`;
  if (Array.isArray(v)) return v.map(typeOf);
  if (typeof v === 'object' && v._bsontype) return v._bsontype;
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeOf(x)]));
  return typeof v;
};
const scalar = (v) => (v && typeof v === 'object' && v._bsontype === 'ObjectId' ? v.hex : v && typeof v === 'object' && typeof v.valueOf === 'function' && !(v instanceof Date) ? v.valueOf() : v instanceof Date ? v.getTime() : v);
const get = (doc, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = get(doc, k);
    if (cond instanceof RegExp) return typeof v === 'string' && cond.test(v);
    if (cond && typeof cond === 'object' && !cond._bsontype && !(cond instanceof Date) && Object.keys(cond).some((x) => x.startsWith('$'))) {
      return Object.entries(cond).every(([op, x]) => {
        const a = scalar(v);
        const b = scalar(x);
        switch (op) {
          case '$gt': return a > b;
          case '$gte': return a >= b;
          case '$lt': return a < b;
          case '$lte': return a <= b;
          case '$ne': return a !== b;
          case '$in': return x.map(scalar).includes(a);
          case '$regex': return new RegExp(x, cond.$options || '').test(v);
          case '$options': return true;
          default: throw new Error(`fake mongodb: unsupported operator ${op}`);
        }
      });
    }
    return scalar(v) === scalar(cond);
  });
}

const sorter = (spec) => (a, b) => {
  for (const [k, dir] of Object.entries(spec)) {
    const x = scalar(get(a, k));
    const y = scalar(get(b, k));
    if (x !== y) return (x < y ? -1 : 1) * Math.sign(scalar(dir));
  }
  return 0;
};
const project = (doc, p) => {
  if (!p || !Object.keys(p).length) return doc;
  const include = Object.entries(p).filter(([k, v]) => scalar(v) && k !== '_id').map(([k]) => k);
  const out = {};
  if (p._id === undefined || scalar(p._id)) out._id = doc._id;
  if (include.length) for (const k of include) { if (k in doc) out[k] = doc[k]; } else Object.assign(out, doc);
  for (const [k, v] of Object.entries(p)) if (!scalar(v)) delete out[k];
  return out;
};

const D = (iso) => new Date(iso);
const store = {
  shop: {
    users: [
      { _id: new ObjectId('65a1b2c3d4e5f60718293a40'), name: 'Ada', age: 36, address: { city: 'London', zip: 'NW1' }, tags: ['math', 'poetry'], joined: D('1842-01-01T00:00:00Z') },
      { _id: new ObjectId('65a1b2c3d4e5f60718293a41'), name: 'Linus', age: 54, address: { city: 'Portland' }, tags: [], joined: D('1991-08-25T00:00:00Z'), balance: new Long('9007199254740993') },
      { _id: new ObjectId('65a1b2c3d4e5f60718293a42'), name: 'Grace', age: 85, address: null, tags: ['navy'] },
    ],
    orders: [{ _id: 1, user: 'Ada', total: 12.5 }, { _id: 2, user: 'Linus', total: 3 }],
  },
  admin: { 'system.version': [{ _id: 'featureCompatibilityVersion', version: '8.0' }] },
};

function cursorOver(docs, { finish = (x) => x } = {}) {
  const st = { sort: null, skip: 0, limit: 0, projection: null };
  const run = () => {
    let out = [...docs];
    if (st.sort) out.sort(sorter(st.sort));
    out = out.slice(st.skip);
    if (st.limit) out = out.slice(0, st.limit);
    return finish(out.map((d) => project(d, st.projection)));
  };
  const cursor = {
    sort(s) { st.sort = s; return cursor; },
    skip(n) { st.skip = n; return cursor; },
    limit(n) { st.limit = n; return cursor; },
    project(p) { st.projection = p; return cursor; },
    hint() { return cursor; },
    maxTimeMS() { return cursor; },
    async toArray() { return run(); },
    async *[Symbol.asyncIterator]() { yield* run(); },
  };
  return cursor;
}

function aggregate(docs, pipeline) {
  let out = [...docs];
  for (const stage of pipeline) {
    const [op, arg] = Object.entries(stage)[0];
    if (op === '$match') out = out.filter((d) => matches(d, arg));
    else if (op === '$sample') out = out.slice(0, arg.size);
    else if (op === '$sort') out.sort(sorter(arg));
    else if (op === '$limit') out = out.slice(0, scalar(arg));
    else if (op === '$group') {
      const groups = new Map();
      for (const d of out) {
        const key = typeof arg._id === 'string' && arg._id.startsWith('$') ? get(d, arg._id.slice(1)) : arg._id;
        if (!groups.has(key)) groups.set(key, { _id: key });
        const g = groups.get(key);
        for (const [f, acc] of Object.entries(arg)) {
          if (f === '_id') continue;
          const src = acc.$sum;
          g[f] = (g[f] || 0) + (typeof src === 'string' ? scalar(get(d, src.slice(1))) || 0 : scalar(src));
        }
      }
      out = [...groups.values()];
    } else throw new Error(`fake mongodb: unsupported stage ${op}`);
  }
  return cursorOver(out);
}

function collection(dbName, name) {
  const docs = () => ((store[dbName] ||= {})[name] ||= []);
  const note = (op, args) => log({ op, db: dbName, coll: name, args: args.map(typeOf), raw: args });
  const apply = (doc, update) => {
    for (const [op, fields] of Object.entries(update)) {
      for (const [k, v] of Object.entries(fields)) {
        if (op === '$set') doc[k] = v;
        else if (op === '$inc') doc[k] = (scalar(doc[k]) || 0) + scalar(v);
        else if (op === '$unset') delete doc[k];
        else throw new Error(`fake mongodb: unsupported update ${op}`);
      }
    }
  };
  return {
    find(filter = {}, opts = {}) { note('find', [filter, opts]); const c = cursorOver(docs().filter((d) => matches(d, filter))); return opts.projection ? c.project(opts.projection) : c; },
    async findOne(filter = {}, opts = {}) { note('findOne', [filter, opts]); const d = docs().find((x) => matches(x, filter)); return d ? project(d, opts.projection) : null; },
    async countDocuments(filter = {}) { note('countDocuments', [filter]); return docs().filter((d) => matches(d, filter)).length; },
    async estimatedDocumentCount() { return docs().length; },
    async distinct(field, filter = {}) { note('distinct', [field, filter]); return [...new Set(docs().filter((d) => matches(d, filter)).map((d) => get(d, field)).flat())]; },
    aggregate(pipeline) { note('aggregate', [pipeline]); return aggregate(docs(), pipeline); },
    async insertOne(doc) { note('insertOne', [doc]); doc._id ??= new ObjectId(); docs().push(doc); return { acknowledged: true, insertedId: doc._id }; },
    async insertMany(list) {
      note('insertMany', [list]);
      const insertedIds = {};
      list.forEach((d, i) => { d._id ??= new ObjectId(); docs().push(d); insertedIds[i] = d._id; });
      return { acknowledged: true, insertedCount: list.length, insertedIds };
    },
    async updateOne(filter, update) { note('updateOne', [filter, update]); const d = docs().find((x) => matches(x, filter)); if (d) apply(d, update); return { acknowledged: true, matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0, upsertedCount: 0, upsertedId: null }; },
    async updateMany(filter, update) { note('updateMany', [filter, update]); const m = docs().filter((x) => matches(x, filter)); m.forEach((d) => apply(d, update)); return { acknowledged: true, matchedCount: m.length, modifiedCount: m.length, upsertedCount: 0, upsertedId: null }; },
    async deleteOne(filter) { note('deleteOne', [filter]); const i = docs().findIndex((x) => matches(x, filter)); if (i >= 0) docs().splice(i, 1); return { acknowledged: true, deletedCount: i >= 0 ? 1 : 0 }; },
    async deleteMany(filter) { note('deleteMany', [filter]); const keep = docs().filter((x) => !matches(x, filter)); const n = docs().length - keep.length; store[dbName][name] = keep; return { acknowledged: true, deletedCount: n }; },
    async createIndex(keys) { note('createIndex', [keys]); return Object.entries(keys).map(([k, v]) => `${k}_${scalar(v)}`).join('_'); },
    async indexes() { return [{ v: 2, key: { _id: 1 }, name: '_id_' }]; },
    async drop() { delete store[dbName][name]; return true; },
  };
}

function db(name) {
  return {
    databaseName: name,
    collection: (c) => collection(name, c),
    listCollections() { return { toArray: async () => Object.keys(store[name] || {}).map((c) => ({ name: c, type: 'collection' })) }; },
    async command(doc) {
      log({ op: 'command', db: name, args: [typeOf(doc)], raw: [doc] });
      if (doc.buildInfo) return { version: '8.0.0-fake', ok: 1 };
      if (doc.ping) return { ok: 1 };
      if (doc.dbStats) return { db: name, collections: Object.keys(store[name] || {}).length, ok: 1 };
      throw new Error(`no such command: '${Object.keys(doc)[0]}'`);
    },
    async createCollection(c) { (store[name] ||= {})[c] ||= []; },
    async dropDatabase() { delete store[name]; return true; },
    admin: () => ({ listDatabases: async () => ({ databases: Object.keys(store).sort().map((n) => ({ name: n, sizeOnDisk: 4096, empty: false })) }) }),
  };
}

class MongoClient {
  constructor(uri, options) { this.uri = uri; log({ op: 'client', uri, options }); }
  async connect() { if (/unreachable/.test(this.uri)) throw new Error('connect ECONNREFUSED 127.0.0.1:1'); return this; }
  db(name) { return db(name); }
  on() { return this; }
  async close() { log({ op: 'close' }); }
}

module.exports = { MongoClient, ObjectId, Long, Int32, Double, Decimal128, Binary, UUID, Timestamp, MinKey, MaxKey };
