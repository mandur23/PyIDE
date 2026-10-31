// MongoDB through the official mongodb package. The console speaks the shell dialect parsed by main/db/mongo-shell.js
// (no eval); results come back as documents for the JSON view plus their top-level fields as grid columns. The tree
// lists databases and collections, and samples a collection's field names and types when it is expanded.
// See main/db/drivers.js for the kind module contract.
const { parseCommand, ShellValue, openDataCommand } = require('../mongo-shell');

const SAMPLE = 100;

// BSON values as JSON with the shell's tagged forms ({$oid}, {$date}, ...), which the renderer shows as ObjectId('..'),
// ISODate('..') and so on. Detection goes by _bsontype, so any BSON library version works.
function plain(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (depth > 64) return '…';
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? String(v) : v.toISOString() };
  if (v instanceof RegExp) return { $regex: v.source, $options: v.flags };
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : { $numberLong: v.toString() };
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $numberDouble: String(v) };
  if (typeof v !== 'object') return v;
  switch (v._bsontype) {
    case 'ObjectId': case 'ObjectID': return { $oid: v.toHexString() };
    case 'Long': { const s = v.toString(); return Number.isSafeInteger(Number(s)) ? Number(s) : { $numberLong: s }; }
    case 'Int32': case 'Double': return plain(v.valueOf());
    case 'Decimal128': return { $numberDecimal: v.toString() };
    case 'Timestamp': return { $timestamp: { t: v.high ?? v.t, i: v.low ?? v.i } };
    case 'Binary': return v.sub_type === 4 && typeof v.toUUID === 'function' ? { $uuid: v.toUUID().toHexString() } : { $binary: { base64: Buffer.from(v.buffer).toString('base64'), subType: (v.sub_type ?? 0).toString(16).padStart(2, '0') } };
    case 'BSONRegExp': return { $regex: v.pattern, $options: v.options };
    case 'MinKey': return { $minKey: 1 };
    case 'MaxKey': return { $maxKey: 1 };
    case 'Code': return { $code: v.code };
    case 'DBRef': return { $ref: v.collection, $id: plain(v.oid, depth + 1) };
    case 'BSONSymbol': return String(v.value ?? v);
    default: break;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $binary: { base64: Buffer.from(v).toString('base64'), subType: '00' } };
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: plain(x, depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}

// One tagged value as the shell would print it.
const TAGS = {
  $oid: (v) => `ObjectId('${v}')`, $date: (v) => `ISODate('${v}')`, $numberLong: (v) => `NumberLong('${v}')`, $numberDecimal: (v) => `NumberDecimal('${v}')`,
  $numberDouble: (v) => v, $uuid: (v) => `UUID('${v}')`, $timestamp: (v) => `Timestamp(${v.t}, ${v.i})`, $binary: (v) => `BinData(${parseInt(v.subType, 16)}, '${v.base64}')`,
  $minKey: () => 'MinKey()', $maxKey: () => 'MaxKey()', $code: (v) => `Code(${JSON.stringify(v)})`,
};
const tagOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length === 1 && TAGS[keys[0]]) return keys[0];
  if (keys.length === 2 && '$regex' in v && '$options' in v && typeof v.$regex === 'string') return '$regex';
  return null;
};
function shellText(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(shellText).join(', ')}]`;
  if (typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
  const tag = tagOf(v);
  if (tag === '$regex') return `/${v.$regex}/${v.$options}`;
  if (tag) return TAGS[tag](v[tag]);
  const entries = Object.entries(v);
  return entries.length ? `{ ${entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${shellText(x)}`).join(', ')} }` : '{}';
}

// Grid cell: ObjectId as its hex, dates as ISO text, other tagged values and nested documents in shell syntax.
function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  const tag = tagOf(v);
  if (tag === '$oid' || tag === '$date' || tag === '$numberLong' || tag === '$numberDecimal' || tag === '$uuid') return v[tag];
  return shellText(v);
}

function typeName(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  const tag = tagOf(v);
  return ({ $oid: 'objectId', $date: 'date', $numberLong: 'long', $numberDecimal: 'decimal', $numberDouble: 'double', $uuid: 'uuid', $timestamp: 'timestamp',
    $binary: 'binData', $regex: 'regex', $minKey: 'minKey', $maxKey: 'maxKey', $code: 'javascript' })[tag] || 'object';
}

// Documents -> {columns, rows}: the union of top-level fields in first-seen order, _id first.
function flatten(docs) {
  const names = [];
  const seen = new Set();
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  if (seen.has('_id')) names.splice(names.indexOf('_id'), 1), names.unshift('_id');
  const columns = names.map((name) => ({ name, type: typeName(docs.find((d) => d[name] !== null && d[name] !== undefined)?.[name]) }));
  return { columns, rows: docs.map((d) => names.map((n) => cell(d[n]))) };
}

// Field names and types sampled from documents, nested documents as children.
function sampleFields(docs, depth = 0) {
  const fields = new Map();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      if (!fields.has(k)) fields.set(k, { types: new Set(), nested: [] });
      const f = fields.get(k);
      f.types.add(typeName(v));
      if (depth < 4 && typeName(v) === 'object') f.nested.push(v);
      if (depth < 4 && Array.isArray(v)) f.nested.push(...v.filter((x) => typeName(x) === 'object'));
    }
  }
  const nodes = [...fields].map(([name, f]) => {
    const node = { name, kind: 'field', detail: [...f.types].join(' | ') };
    if (f.nested.length) node.children = sampleFields(f.nested, depth + 1);
    return node;
  });
  const id = nodes.findIndex((n) => n.name === '_id');
  if (id > 0) nodes.unshift(...nodes.splice(id, 1));
  return nodes;
}

const COLLECTION_METHODS = ['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'aggregate', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'getIndexes', 'dropIndex', 'drop'];
const DB_METHODS = ['runCommand', 'adminCommand', 'getCollectionNames', 'createCollection', 'dropDatabase', 'stats', 'getName'];
const CURSOR_METHODS = { find: ['sort', 'limit', 'skip', 'project', 'projection', 'hint', 'maxTimeMS', 'batchSize', 'collation', 'comment', 'toArray', 'pretty'], aggregate: ['toArray', 'pretty'] };

module.exports = ({ loadPackage, timed }) => {
  // Parsed shell values -> the driver's BSON types.
  function bson(mongo, v) {
    if (v instanceof ShellValue) {
      switch (v.type) {
        case 'ObjectId': return v.value ? new mongo.ObjectId(v.value) : new mongo.ObjectId();
        case 'Long': return mongo.Long.fromString(v.value);
        case 'Int32': return new mongo.Int32(v.value);
        case 'Double': return new mongo.Double(v.value);
        case 'Decimal128': return mongo.Decimal128.fromString(v.value);
        case 'UUID': return v.value ? new mongo.UUID(v.value) : new mongo.UUID();
        case 'Timestamp': return new mongo.Timestamp({ t: v.value.t, i: v.value.i });
        case 'Binary': return new mongo.Binary(Buffer.from(v.value.base64, 'base64'), v.value.subType);
        case 'MinKey': return new mongo.MinKey();
        case 'MaxKey': return new mongo.MaxKey();
        default: throw new Error(`Unsupported value ${v.type}`);
      }
    }
    if (Array.isArray(v)) return v.map((x) => bson(mongo, x));
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof RegExp)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: bson(mongo, x), enumerable: true, writable: true, configurable: true });
      return out;
    }
    return v;
  }

  // The connection string with the password put back (it is stored separately, encrypted), or one built from fields.
  function connectionString(cfg) {
    const enc = encodeURIComponent;
    if (cfg.uri) {
      const m = cfg.uri.match(/^(mongodb(?:\+srv)?:\/\/)([^@/]*@)?(.*)$/i);
      if (!m) throw new Error('The connection string must start with mongodb:// or mongodb+srv://');
      if (m[2] && cfg.password && !m[2].includes(':')) return `${m[1]}${m[2].slice(0, -1)}:${enc(cfg.password)}@${m[3]}`;
      return cfg.uri;
    }
    const auth = cfg.user ? `${enc(cfg.user)}${cfg.password ? `:${enc(cfg.password)}` : ''}@` : '';
    const params = new URLSearchParams();
    if (cfg.user && cfg.authSource) params.set('authSource', cfg.authSource);
    if (cfg.tls) params.set('tls', 'true');
    const q = params.toString();
    return `mongodb://${auth}${cfg.host || '127.0.0.1'}:${cfg.port || 27017}/${q ? `?${q}` : ''}`;
  }

  async function openMongo(cfg, { onLost = () => {} } = {}) {
    const mongo = loadPackage('mongodb');
    const client = new mongo.MongoClient(connectionString(cfg), { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, appName: 'Nano Studio' });
    await client.connect();
    let closing = false;
    // The driver reconnects by itself; the IDE still hears when no server of the deployment answers any more.
    client.on('topologyDescriptionChanged', (e) => {
      const servers = [...(e.newDescription?.servers?.values?.() || [])];
      if (!closing && servers.length && servers.every((s) => s.type === 'Unknown')) onLost(new Error('Server unreachable'));
    });
    const uriDb = cfg.uri?.match(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/i)?.[1];
    let current = cfg.database || (uriDb && decodeURIComponent(uriDb)) || 'test';

    const docsResult = (docs, { maxRows, command, truncated = false, extra = {} }) => {
      const documents = docs.slice(0, maxRows).map((d) => plain(d));
      const shown = documents.map((d) => (d && typeof d === 'object' && !Array.isArray(d) ? d : { value: d }));
      return { ...flatten(shown), documents, rowCount: documents.length, truncated: truncated || docs.length > maxRows, command, ...extra };
    };
    const valuesResult = (name, values, opts) => {
      const plainValues = values.map((v) => plain(v));
      return { columns: [{ name, type: typeName(plainValues[0]) }], rows: plainValues.slice(0, opts.maxRows).map((v) => [cell(v)]), rowCount: Math.min(values.length, opts.maxRows), truncated: values.length > opts.maxRows, command: opts.command };
    };
    const writeResult = (r, affected, command, schemaChanged = false) => {
      const doc = plain(r);
      return { ...flatten([doc]), documents: [doc], rowCount: 1, affected, truncated: false, command, schemaChanged };
    };

    async function run(text, maxRows) {
      const cmd = parseCommand(text);
      if (cmd.type === 'use') {
        current = cmd.db;
        return { columns: [], rows: [], rowCount: null, truncated: false, command: 'USE', notice: { text: 'Switched to database {name}', args: { name: cmd.db } } };
      }
      if (cmd.type === 'show') {
        if (cmd.what === 'dbs' || cmd.what === 'databases') {
          const { databases } = await client.db('admin').admin().listDatabases();
          return docsResult(databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty })), { maxRows, command: 'SHOW' });
        }
        if (cmd.what === 'collections' || cmd.what === 'tables') {
          const list = await client.db(current).listCollections({}, { nameOnly: true }).toArray();
          return docsResult(list.map((c) => ({ name: c.name, type: c.type })).sort((a, b) => (a.name < b.name ? -1 : 1)), { maxRows, command: 'SHOW' });
        }
        throw new Error(`Unknown show target "${cmd.what}". Use show dbs or show collections.`);
      }
      const database = client.db(cmd.db || current);
      const a = cmd.args.map((x) => bson(mongo, x));
      const label = `db.${cmd.collection ? `${cmd.collection}.` : ''}${cmd.method}()`;
      const allowedChain = CURSOR_METHODS[cmd.method] || [];
      for (const c of cmd.chain) if (!allowedChain.includes(c.method)) throw new Error(`.${c.method}() is not supported after ${label}`);
      const command = cmd.method.toUpperCase();

      if (!cmd.collection) {
        if (!DB_METHODS.includes(cmd.method)) throw new Error(`Unsupported method ${label}. Supported: ${DB_METHODS.map((m) => `db.${m}()`).join(', ')}`);
        switch (cmd.method) {
          case 'runCommand': case 'adminCommand': {
            const target = cmd.method === 'adminCommand' ? client.db('admin') : database;
            const doc = typeof a[0] === 'string' ? { [a[0]]: 1 } : a[0];
            if (!doc || typeof doc !== 'object') throw new Error(`${label} expects a command document`);
            return docsResult([await target.command(doc)], { maxRows, command });
          }
          case 'getCollectionNames': return valuesResult('name', (await database.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(), { maxRows, command });
          case 'createCollection': await database.createCollection(String(a[0]), a[1]); return writeResult({ ok: 1 }, null, command, true);
          case 'dropDatabase': return writeResult({ ok: 1, dropped: database.databaseName, done: await database.dropDatabase() }, null, command, true);
          case 'stats': return docsResult([await database.command({ dbStats: 1 })], { maxRows, command });
          case 'getName': return valuesResult('name', [database.databaseName], { maxRows, command });
          default: break;
        }
      }
      if (!COLLECTION_METHODS.includes(cmd.method)) throw new Error(`Unsupported method ${label}. Supported: ${COLLECTION_METHODS.map((m) => `${m}()`).join(', ')}`);
      const coll = database.collection(cmd.collection);
      switch (cmd.method) {
        case 'find': {
          let cursor = coll.find(a[0] || {}, a[1] ? { projection: a[1] } : {});
          let limit = 0;
          for (const c of cmd.chain) {
            const [x] = c.args.map((v) => bson(mongo, v));
            if (c.method === 'limit') limit = Math.abs(Number(x) || 0);
            else if (c.method === 'project' || c.method === 'projection') cursor = cursor.project(x);
            else if (!['toArray', 'pretty'].includes(c.method)) cursor = cursor[c.method](x);
          }
          const take = limit && limit <= maxRows ? limit : maxRows + 1;
          const docs = await cursor.limit(take).toArray();
          return docsResult(docs, { maxRows, command: 'FIND' });
        }
        case 'findOne': {
          const doc = await coll.findOne(a[0] || {}, a[1] ? { projection: a[1] } : {});
          return docsResult(doc ? [doc] : [], { maxRows, command: 'FIND' });
        }
        case 'countDocuments': return valuesResult('count', [await coll.countDocuments(a[0] || {}, a[1])], { maxRows, command });
        case 'estimatedDocumentCount': return valuesResult('count', [await coll.estimatedDocumentCount()], { maxRows, command });
        case 'distinct': return valuesResult(String(a[0]), await coll.distinct(String(a[0]), a[1] || {}), { maxRows, command });
        case 'aggregate': {
          if (!Array.isArray(a[0])) throw new Error('aggregate() expects a pipeline array');
          const docs = [];
          let truncated = false;
          for await (const d of coll.aggregate(a[0], a[1])) {
            if (docs.length >= maxRows) { truncated = true; break; }
            docs.push(d);
          }
          return docsResult(docs, { maxRows, command: 'AGGREGATE', truncated, extra: { schemaChanged: a[0].some((s) => s && ('$out' in s || '$merge' in s)) } });
        }
        case 'insertOne': { const r = await coll.insertOne(a[0] || {}); return writeResult(r, 1, 'INSERT', true); }
        case 'insertMany': {
          if (!Array.isArray(a[0])) throw new Error('insertMany() expects an array of documents');
          const r = await coll.insertMany(a[0], a[1]);
          return writeResult({ acknowledged: r.acknowledged, insertedCount: r.insertedCount, insertedIds: Object.values(r.insertedIds) }, r.insertedCount, 'INSERT', true);
        }
        case 'updateOne': case 'updateMany': case 'replaceOne': {
          const r = await coll[cmd.method](a[0] || {}, a[1], a[2]);
          return writeResult(r, r.modifiedCount + (r.upsertedCount || 0), 'UPDATE', !!r.upsertedCount);
        }
        case 'deleteOne': case 'deleteMany': { const r = await coll[cmd.method](a[0] || {}, a[1]); return writeResult(r, r.deletedCount, 'DELETE'); }
        case 'createIndex': return valuesResult('name', [await coll.createIndex(a[0], a[1])], { maxRows, command });
        case 'getIndexes': return docsResult(await coll.indexes(), { maxRows, command });
        case 'dropIndex': return docsResult([await coll.dropIndex(a[0])], { maxRows, command });
        case 'drop': return writeResult({ ok: 1, dropped: await coll.drop() }, null, command, true);
        default: throw new Error(`Unsupported method ${label}`);
      }
    }

    return {
      query: (text, { maxRows }) => timed(() => run(text, maxRows)),
      async schema() {
        let names;
        try {
          names = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
        } catch {
          names = []; // Users without listDatabases rights still see their own database.
        }
        if (!names.includes(current)) names.push(current);
        names.sort();
        return Promise.all(names.map(async (name) => {
          let list = [];
          try { list = await client.db(name).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray(); } catch {}
          return {
            name, kind: 'database', emptyText: 'No collections',
            children: list.filter((c) => !c.name.startsWith('system.')).sort((x, y) => (x.name < y.name ? -1 : 1)).map((c) => ({
              name: c.name, kind: c.type === 'view' ? 'view' : 'collection', lazy: true, emptyText: 'No fields', open: openDataCommand(name, c.name),
            })),
          };
        }));
      },
      async children([db, collection]) {
        const docs = await client.db(db).collection(collection).aggregate([{ $sample: { size: SAMPLE } }]).toArray();
        return sampleFields(docs.map((d) => plain(d)));
      },
      async version() {
        const info = await client.db('admin').command({ buildInfo: 1 });
        return `MongoDB ${info.version}`;
      },
      close: async () => { closing = true; await client.close(); },
    };
  }

  return {
    packages: { mongodb: 'mongodb@7' },
    kinds: {
      mongodb: {
        label: 'MongoDB', order: 50, package: 'mongodb', defaultPort: 27017, quote: '"', implicitSchemas: [],
        fields: [
          { key: 'uri', label: 'Connection string', type: 'url', placeholder: 'mongodb://localhost:27017' },
          'host', 'port', 'user', 'password', 'database',
          { key: 'authSource', label: 'Auth database', placeholder: 'admin' },
          { key: 'tls', label: 'Use TLS', type: 'checkbox' },
        ],
        ui: { language: 'mongosh', statementSeparator: 'mongo' },
        open: openMongo,
      },
    },
  };
};

module.exports.forTests = { plain, flatten, shellText, sampleFields, cell };
