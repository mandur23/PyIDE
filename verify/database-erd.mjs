// Database › Generate ERD over SQLite: the data source's and a schema's context menus open a diagram tab with the
// tables and views, their columns (primary keys marked), and foreign keys as labelled associations, composite keys
// included, laid out in columns with each key running row to row around the boxes; Refresh reads a changed schema
// again; the database tree draws SVG icons.
import { mkdtempSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

process.env.PYIDE_DB_DRIVERS = mkdtempSync(path.join(tmpdir(), 'pyide-db-drivers-'));
const S = JSON.stringify;

const t = await launch({ fixture: 'database', port: 9636, name: 'database-erd' });
const { js, until, check, shot, cdp } = t;
const rightClick = async (selector) => {
  await until(`document.querySelector(${S(selector)})`, selector);
  const box = await js(`(() => { const r = document.querySelector(${S(selector)}).getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
};
const menuLabels = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map((r) => r.firstChild.textContent)`);
const choose = (label) => js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.firstChild.textContent === ${S(label)}); r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); r.click(); return true; })()`);
const state = () => js(`(() => { const s = ide.diagrams.state(); return s && { tabId: s.tabId, classes: s.classes.map((c) => c.qualname).sort(), edges: s.edges.map((e) => \`\${e.from}>\${e.to}:\${e.label}\`).sort() }; })()`);

try {
  const file = path.join(t.project, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, referred_by INTEGER REFERENCES customers(id));
    CREATE TABLE products (sku TEXT, region TEXT, title TEXT, PRIMARY KEY (sku, region));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), placed TEXT);
    CREATE TABLE order_items (order_id INTEGER REFERENCES orders, sku TEXT, region TEXT, qty INTEGER, gift_for INTEGER REFERENCES customers(id),
      FOREIGN KEY (sku, region) REFERENCES products (sku, region));
    CREATE TABLE stores (id INTEGER PRIMARY KEY, manager_id INTEGER REFERENCES staff(id));
    CREATE TABLE staff (id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES stores(id));
    CREATE VIEW big_orders AS SELECT * FROM orders;`);
  db.close();
  const id = await js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${S(file)} })`);
  await js(`(ide.toolWindows.get('Database').show(), true)`);
  await until(`document.querySelector('#dbTree .db-node.db-source')`, 'data source row');
  check(await js(`[...document.querySelectorAll('#dbTree .db-node .db-icon')].every((i) => i.querySelector('svg'))`), 'the database tree draws SVG icons');

  await rightClick('#dbTree .db-node.db-source');
  await until(`document.querySelector('.context-menu .menu-item')`, 'source menu');
  const labels = await menuLabels();
  check(labels.includes('Generate ERD') && labels.indexOf('Generate ERD') === labels.indexOf('New Query Console') + 1, `the data source's menu has Generate ERD (${labels.join(' | ')})`);
  await choose('Generate ERD');
  await until(`ide.diagrams.state()?.classes.length >= 7`, 'ERD drawn', 15000);
  const erd = await state();
  check(S(erd.classes) === S(['main.big_orders', 'main.customers', 'main.order_items', 'main.orders', 'main.products', 'main.staff', 'main.stores']), `every table and view is a box (${erd.classes.join(', ')})`);
  check(S(erd.edges) === S(['main.customers>main.customers:referred_by', 'main.order_items>main.customers:gift_for', 'main.order_items>main.orders:order_id', 'main.order_items>main.products:sku, region',
    'main.orders>main.customers:customer_id', 'main.staff>main.stores:store_id', 'main.stores>main.staff:manager_id']),
    `foreign keys are associations labelled with their columns, composite ones as one, a table's key to itself and keys that loop included (${erd.edges.join(' ; ')})`);

  // The layout: referenced tables stand left of the tables that reference them, every key runs from its column's row
  // to the referenced column's row with right angles, and no key crosses a box.
  const geo = await js(`(() => {
    const s = ide.diagrams.state();
    const box = Object.fromEntries(s.classes.map((c) => [c.qualname, c]));
    const row = (t, col) => box[t].y + Number(document.querySelector(\`.dg-node[data-id="\${t}"] .dg-m[data-name="\${col}"] circle\`).getAttribute('cy'));
    const near = (a, b) => Math.abs(a - b) < 0.6;
    const edge = (from, to) => s.edges.find((e) => e.from === from && e.to === to);
    const ends = (from, col, to, refCol, side = 'left') => {
      const e = edge(from, to);
      const [a, z] = [e.points[0], e.points[e.points.length - 1]];
      const out = side === 'left' ? box[from].x : box[from].x + box[from].w;
      const into = box[to].x + (box[to].x > box[from].x ? 0 : box[to].w);
      return near(a[0], out) && near(a[1], row(from, col)) && near(z[0], into) && near(z[1], row(to, refCol));
    };
    let square = true;
    let through = [];
    for (const e of s.edges) {
      for (let k = 0; k + 1 < e.points.length; k++) {
        const [a, b] = [e.points[k], e.points[k + 1]];
        if (!near(a[0], b[0]) && !near(a[1], b[1])) square = false;
        const [x1, x2, y1, y2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        for (const c of s.classes) if (x2 > c.x + 1 && x1 < c.x + c.w - 1 && y2 > c.y + 1 && y1 < c.y + c.h - 1) through.push(\`\${e.from}>\${e.to} in \${c.qualname}\`);
      }
    }
    return {
      columns: box['main.customers'].x < box['main.orders'].x && box['main.orders'].x < box['main.order_items'].x && box['main.products'].x < box['main.order_items'].x,
      rows: ends('main.orders', 'customer_id', 'main.customers', 'id') && ends('main.order_items', 'order_id', 'main.orders', 'id')
        && ends('main.order_items', 'sku', 'main.products', 'sku') && ends('main.order_items', 'gift_for', 'main.customers', 'id'),
      loop: ends('main.customers', 'referred_by', 'main.customers', 'id', 'right'),
      cycle: (ends('main.stores', 'manager_id', 'main.staff', 'id') || ends('main.stores', 'manager_id', 'main.staff', 'id', 'right'))
        && (ends('main.staff', 'store_id', 'main.stores', 'id') || ends('main.staff', 'store_id', 'main.stores', 'id', 'right')),
      square, through,
      marks: [...document.querySelectorAll('.dg-key')].every((g) => g.querySelector('path.dg-arrow')) && document.querySelectorAll('.dg-key').length === s.edges.length,
    };
  })()`);
  check(geo.columns, 'a referenced table stands left of the tables that reference it (customers, orders, order_items; products)');
  check(geo.rows, 'a key runs from its column\'s row to the referenced column\'s row, a composite key from its first column, and a key skipping a column too');
  check(geo.loop, 'a table\'s key to itself is a loop on its right from the key\'s row to the primary key\'s');
  check(geo.cycle, 'keys that loop between two tables (stores and staff) are both drawn, row to row');
  check(geo.square && !geo.through.length, `keys turn at right angles and cross no box${geo.through.length ? ` (${geo.through.join(', ')})` : ''}`);
  check(geo.marks, 'every key has its ends drawn (a crow\'s foot at the key\'s table, a bar at the referenced one)');
  const colours = await js(`(() => {
    const byTable = new Map();
    for (const g of document.querySelectorAll('.dg-key')) byTable.set(g.dataset.to, [...(byTable.get(g.dataset.to) || []), getComputedStyle(g.querySelector('.dg-line')).stroke]);
    return { same: [...byTable.values()].every((s) => new Set(s).size === 1), distinct: new Set([...byTable.values()].map((s) => s[0])).size, tables: byTable.size };
  })()`);
  check(colours.same && colours.distinct === colours.tables, `keys into one table share its colour and each referenced table has its own (${colours.distinct} colours for ${colours.tables} tables)`);
  check(await js(`document.querySelector('.tab.active .tab-title, .tab.active .name')?.textContent === 'shop'`), 'the tab is named after the data source');
  check(await js(`(() => { const box = [...document.querySelectorAll('.dg-node')].find((n) => n.textContent.includes('products'));
    return box && box.querySelectorAll('.dg-ic-k').length === 2 && box.textContent.includes('title: TEXT'); })()`), 'primary key columns are marked k, the others show their type');
  check(await js(`!document.querySelector('.dg-methods') && !document.querySelector('.dg-private') && document.querySelector('.dg-add')?.textContent === 'Add Table…'`), 'the toolbar has no Python-only toggles and adds tables');
  await shot('erd.png');

  const viaQuery = await js(`ide.database.query(${S(id)}, 'CREATE TABLE reviews (id INTEGER PRIMARY KEY, sku TEXT, region TEXT, FOREIGN KEY (sku, region) REFERENCES products)')`);
  check(viaQuery && !viaQuery.error, 'a table is added to the database');
  await js(`(document.querySelector('.dg-refresh').click(), true)`);
  await until(`ide.diagrams.state()?.classes.some((c) => c.qualname === 'main.reviews')`, 'refreshed ERD', 10000);
  check((await state()).edges.includes('main.reviews>main.products:sku, region'), 'Refresh reads the schema and its keys again');

  await t.click('#dbTree .db-node.db-source');
  await until(`document.querySelector('#dbTree .db-node.db-schema')`, 'schema row', 10000);
  await rightClick('#dbTree .db-node.db-schema');
  await until(`document.querySelector('.context-menu .menu-item')`, 'schema menu');
  check((await menuLabels()).includes('Generate ERD'), 'a schema has Generate ERD too');
  await choose('Generate ERD');
  await until(`ide.diagrams.state()?.tabId?.endsWith(':main')`, 'schema ERD tab', 10000);
  const tabs = await js(`[...document.querySelectorAll('.tab')].map((n) => n.querySelector('.name, .tab-title')?.textContent ?? n.textContent)`);
  check((await state()).tabId !== erd.tabId && tabs.includes('shop') && tabs.includes('shop: main'), `the schema gets its own tab beside the whole source's (${tabs.join(' | ')})`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.finish();
