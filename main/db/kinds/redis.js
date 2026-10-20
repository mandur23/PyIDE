// Redis through the ioredis package. The console runs one redis-cli style command per line; the tree lists the
// databases that hold keys and, on expand, the keys found with SCAN (never KEYS) grouped by `:` with their types.
// See main/db/drivers.js for the kind module contract and main/db/redis-cli.js for parsing and reply shapes.
const { splitArgs, formatReply, groupKeys } = require('../redis-cli');

// Commands that block or take over the connection have no place in a request/response console.
const REFUSED = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC', 'QUIT', 'RESET', 'SHUTDOWN']);
const MAX_KEYS = 10000;

module.exports = ({ loadPackage, timed }) => {
  async function openRedis(cfg, { onLost = () => {} } = {}) {
    const Redis = loadPackage('ioredis');
    const base = {
      host: cfg.host || '127.0.0.1', port: cfg.port || 6379, username: cfg.user || undefined, password: cfg.password || undefined,
      tls: cfg.tls ? { servername: cfg.host } : undefined, connectTimeout: 10000, lazyConnect: true,
      // A lost connection is reported to the IDE instead of retried forever in the background.
      retryStrategy: () => null, maxRetriesPerRequest: 0, enableReadyCheck: false,
    };
    // ioredis rejects a failed connect with "Connection is closed." and reports the cause (WRONGPASS, ECONNREFUSED)
    // as an error event; the cause is what the user needs to see.
    async function connected(opts) {
      const c = new Redis(opts);
      let cause = null;
      c.on('error', (err) => { cause = err; });
      try {
        await c.connect();
      } catch (err) {
        c.disconnect();
        throw cause || err;
      }
      return c;
    }

    let db = Number(cfg.db) || 0;
    const client = await connected({ ...base, db });
    let closing = false;
    client.on('end', () => { if (!closing) onLost(new Error('Connection closed')); });

    // The tree reads other databases on its own short-lived connection, so the console keeps its SELECTed database.
    async function onDb(n, fn) {
      const c = await connected({ ...base, db: n });
      try { return await fn(c); } finally { c.disconnect(); }
    }

    async function scanKeys(c) {
      const keys = [];
      let cursor = '0';
      do {
        const [next, batch] = await c.scan(cursor, 'COUNT', 1000);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0' && keys.length < MAX_KEYS);
      const unique = [...new Set(keys)].slice(0, MAX_KEYS);
      const types = [];
      for (let i = 0; i < unique.length; i += 500) {
        const p = c.pipeline();
        for (const k of unique.slice(i, i + 500)) p.type(k);
        for (const [err, t] of await p.exec()) types.push(err ? '?' : t);
      }
      return { keys: unique.map((key, i) => ({ key, type: types[i] })), more: cursor !== '0' };
    }

    return {
      query: (line, { maxRows }) => timed(async () => {
        const args = splitArgs(line);
        if (!args.length) throw new Error('Empty command');
        const command = args[0].toUpperCase();
        if (REFUSED.has(command)) throw new Error(`${command} is not supported in the query console`);
        const reply = await client.call(...args);
        if (command === 'SELECT') db = Number(args[1]);
        const r = formatReply(args, reply);
        if (!r.columns) return { columns: [], rows: [], rowCount: null, truncated: false, command, message: r.message };
        return { columns: r.columns, rows: r.rows.slice(0, maxRows), rowCount: Math.min(r.rows.length, maxRows), truncated: r.rows.length > maxRows, command,
          message: r.cursor !== undefined ? `cursor ${r.cursor}` : undefined };
      }),
      // Databases that hold keys, and the one this source opens; their keys load on expand (children).
      async schema() {
        const info = await client.info('keyspace');
        const counts = new Map([...info.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
        if (!counts.has(Number(cfg.db) || 0)) counts.set(Number(cfg.db) || 0, 0);
        return [...counts].sort(([a], [b]) => a - b).map(([n, keys]) => ({ name: `db${n}`, kind: 'database', detail: `(${keys})`, lazy: true, emptyText: 'No keys' }));
      },
      async children(path) {
        const n = Number(String(path[0]).replace(/^db/, ''));
        const { keys, more } = await onDb(n, scanKeys);
        const nodes = groupKeys(keys, n);
        if (more) nodes.push({ kind: 'info', label: 'Showing the first {n} keys', args: { n: MAX_KEYS } });
        return nodes;
      },
      async version() { return `Redis ${(await client.info('server')).match(/redis_version:(\S+)/)?.[1] || ''}`.trim(); },
      close: async () => { closing = true; client.disconnect(); },
    };
  }

  return {
    packages: { ioredis: 'ioredis@5' },
    kinds: {
      redis: {
        label: 'Redis', order: 60, package: 'ioredis', defaultPort: 6379, quote: '"', implicitSchemas: [],
        fields: ['host', 'port', { key: 'user', label: 'Username', placeholder: 'default' }, 'password',
          { key: 'db', label: 'Database index', type: 'number', default: 0 }, { key: 'tls', label: 'Use TLS', type: 'checkbox' }],
        ui: { language: 'plaintext', statementSeparator: 'lines' },
        open: openRedis,
      },
    },
  };
};
