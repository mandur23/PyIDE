// User plugins whose renderer index.js fails while it loads: one throws, one has a syntax error, one cannot be read.
// Each is reported once as "Plugin <name> failed to load (index.js)", the Plugins page marks it "Failed to load" with
// the reason (also after the error list is cleared), and the plugins after it still load. A plugin that throws later,
// once loaded, is an internal error but not a load failure. Port 9412.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-plugin-load-'));
const userData = path.join(work, 'userdata');
const plugin = (id, name, script) => {
  const dir = path.join(userData, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), S({ id, name, version: '1.0.0', vendor: 'Test' }));
  writeFileSync(path.join(dir, 'index.js'), script);
  return path.join(dir, 'index.js');
};
plugin('a-throws', 'A Throws', "window.__aStarted = true;\nthrow new Error('a-throws boom');\n");
plugin('b-syntax', 'B Syntax', 'this is not JavaScript\n');
plugin('c-after', 'C After', 'window.__cRan = true;\n');
plugin('d-later', 'D Later', "window.__dRan = true;\nide.on('ready', () => setTimeout(() => { throw new Error('d-later boom'); }, 200));\n");
const unreadable = plugin('e-unreadable', 'E Unreadable', 'window.__eRan = true;\n');
const user = process.env.USERNAME;
execFileSync('icacls', [unreadable, '/deny', `${user}:(R)`], { stdio: 'ignore' });

const t = await launch({ fixture: 'core', port: 9412, name: 'plugin-load-errors', userData });
const { js, until, check, sleep } = t;
const errors = () => js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => ({ message: e.message, kind: e.kind, plugin: e.plugin?.id || null, count: e.count })))`);
const row = (id) => `document.querySelector('#pluginsList .plugin-row[data-id="${id}"]')`;
const marked = (id) => js(`${row(id)}?.querySelector('.plugin-error')?.textContent || ''`);
const reason = async (id) => {
  await js(`(${row(id)}.click(), true)`);
  return js(`document.querySelector('#pluginError')?.textContent || ''`);
};
const closeSettings = async () => {
  await js(`([...document.querySelectorAll('.settings-dialog .dialog-buttons button')].find((b) => b.textContent === 'Cancel')?.click(), true)`);
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed', 5000);
};

try {
  check(await js('window.__aStarted === true && window.__cRan === true && window.__dRan === true && !window.__eRan'),
    'the plugins after one that failed while loading still load');
  check(await js(`typeof ide.lineSeparators?.convert === 'function' && !!document.querySelector('#statusLineSeparator')`), 'bundled plugins load as usual');
  await sleep(800);
  const list = await errors();
  console.log('internal errors:', S(list));
  const failures = (re) => list.filter((e) => re.test(e.message));
  const a = failures(/a-throws boom/);
  check(a.length === 1 && a[0].count === 1 && /^Plugin A Throws failed to load \(index\.js\): a-throws boom/.test(a[0].message) && a[0].plugin === 'a-throws',
    `a plugin script that throws while it loads is reported once as "Plugin A Throws failed to load (index.js)" (${S(a)})`);
  const b = failures(/B Syntax/);
  check(b.length === 1 && /^Plugin B Syntax failed to load \(index\.js\): .*(Unexpected|SyntaxError)/.test(b[0].message) && b[0].plugin === 'b-syntax',
    `a plugin script with a syntax error is reported once (${S(b)})`);
  const e = failures(/E Unreadable/);
  check(e.length === 1 && /^Plugin E Unreadable failed to load \(index\.js\)/.test(e[0].message) && e[0].plugin === 'e-unreadable',
    `a plugin script that cannot be read is reported once (${S(e)})`);
  await until(`ide.api.invoke('diagnostics:errors').then((l) => l.some((e) => /d-later boom/.test(e.message)))`, 'later error reported', 8000).catch(() => {});
  const d = (await errors()).filter((x) => /d-later boom/.test(x.message));
  check(d.length === 1 && !/failed to load/.test(d[0].message), `an error a plugin throws once loaded stays an ordinary internal error (${S(d)})`);

  await js(`ide.api.invoke('diagnostics:clear')`);
  await js(`ide.openSettings('plugins')`);
  await until(`!!${row('a-throws')}`, 'plugin rows', 10000);
  const marks = {};
  for (const id of ['a-throws', 'b-syntax', 'c-after', 'd-later', 'e-unreadable']) marks[id] = await marked(id);
  check(marks['a-throws'] === 'Failed to load' && marks['b-syntax'] === 'Failed to load' && marks['e-unreadable'] === 'Failed to load',
    `the Plugins page marks the plugins whose script failed while loading, also after the error list was cleared (${S(marks)})`);
  check(!marks['c-after'] && !marks['d-later'], `plugins that loaded are not marked, also one that threw later (${S(marks)})`);
  const why = await reason('a-throws');
  check(/^Failed to load: a-throws boom$/.test(why), `the Plugins page shows the reason (${S(why)})`);
  const whySyntax = await reason('b-syntax');
  check(/^Failed to load: .*(Unexpected|SyntaxError)/.test(whySyntax), `the reason of a syntax error is shown (${S(whySyntax)})`);
  check(!(await reason('c-after')), 'a plugin that loaded shows no load error');
  await closeSettings();
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
} finally {
  try { execFileSync('icacls', [unreadable, '/remove:d', user], { stdio: 'ignore' }); } catch {}
}
t.close();
await sleep(1000);
try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {}
t.consoleErrors.splice(0, t.consoleErrors.length, ...t.consoleErrors.filter((x) => !/a-throws boom|d-later boom|Unexpected identifier/.test(x)));
t.finish();
