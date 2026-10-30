// Database › Generate ERD over SQLite: the data source's and a schema's context menus open a diagram tab with the
// tables and views, their columns (primary keys marked), and foreign keys as labelled associations, composite keys
// included; Refresh reads a changed schema again; the database tree draws SVG icons.
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
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (sku TEXT, region TEXT, title TEXT, PRIMARY KEY (sku, region));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), placed TEXT);
    CREATE TABLE order_items (order_id INTEGER REFERENCES orders, sku TEXT, region TEXT, qty INTEGER,
      FOREIGN KEY (sku, region) REFERENCES products (sku, region));
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
  await until(`ide.diagrams.state()?.classes.length >= 5`, 'ERD drawn', 15000);
  const erd = await state();
  check(S(erd.classes) === S(['main.big_orders', 'main.customers', 'main.order_items', 'main.orders', 'main.products']), `every table and view is a box (${erd.classes.join(', ')})`);
  check(S(erd.edges) === S(['main.order_items>main.orders:order_id', 'main.order_items>main.products:sku, region', 'main.orders>main.customers:customer_id']),
    `foreign keys are associations labelled with their columns, composite ones as one (${erd.edges.join(' ; ')})`);
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
