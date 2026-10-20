// Corrupt or hostile state in the user-data folder: every store PyIDE reads at start (settings, interpreter probes,
// plugin state and plugin.json, local history, semantic exclusions and index, data sources, server credentials) is
// replaced with values of the wrong kind, then with text that is not JSON. The IDE must still open the project and
// work, without internal errors. A last project or command-line folder on a network share that does not answer must
// not hold up the window or the main process (ports 9861-9862).
import { launch } from './lib.mjs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-hostile-state-'));
const project = path.join(work, 'project');
cpSync(path.join(APP_DIR, 'verify', 'fixtures', 'core'), project, { recursive: true });
const sha16 = (s) => createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 16);
// A share on an address nothing answers on: opening it fails after about 20 s.
const DEAD_SHARE = '\\\\10.255.255.1\\pyide-share\\project';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const userDataWith = (name, files) => {
  const dir = path.join(work, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};
const noErrors = async (t, what) => {
  const internal = await t.js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => e.message + ' @ ' + (e.stack || '').split('\\n').slice(1, 3).join(' | ')))`);
  check(internal.length === 0, `${what}: no internal errors${internal.length ? `:\n  ${internal.join('\n  ')}` : ''}`);
  check(t.consoleErrors.length === 0, `${what}: no renderer exceptions${t.consoleErrors.length ? `:\n  ${t.consoleErrors.join('\n  ')}` : ''}`);
};
// Opens a file, the run configurations, the Database tool window, Local History and Settings, as a user would.
const exercise = async (t) => {
  await t.until(`ide.root && document.querySelectorAll('#tree .node').length > 2`, 'project tree rows');
  await t.js(`ide.openFile(ide.util.joinPath(ide.root, 'hello.py'))`);
  await t.until(`ide.activeTab()?.path.endsWith('hello.py')`, 'hello.py tab');
  await t.js(`ide.run.editConfigurations()`);
  await t.until(`document.querySelector('.rc-dialog')`, 'Run/Debug Configurations dialog');
  await t.press('Escape');
  await t.js(`ide.toolWindows.get('Database')?.show()`);
  await t.js(`ide.localHistory.show(ide.util.joinPath(ide.root, 'hello.py'), false)`);
  await t.sleep(800);
  await t.press('Escape');
  await t.js(`ide.openSettings()`);
  await t.sleep(500);
  await t.press('Escape');
  await t.sleep(300);
};

// ---------- 1. values of the wrong kind ----------
{
  const userData = userDataWith('userdata-kinds', {
    'settings.json': JSON.stringify({
      recentProjects: [null, 5, 'C:\\text-entry', { path: 7 }, { path: 'C:\\pyide-gone-1b7c' }, { path: project, opened: 'x' }],
      'projectTree.expanded': 'garbage',
      [`runConfigs:${project}`]: { configs: [null, 5, { id: 7 }], selected: 5 },
      [`interpreter.${project}`]: 5,
      'interpreters.extra': 'C:\\Python\\python.exe',
      'sidebar.pinned': 5,
      'workspace.collapsed': 5,
      'workspace.recent': { a: 1 },
      'terminal.shell': 5,
      'terminal.fontSize': 'huge',
      'editor.fontSize': 'huge',
      'appearance.theme': 5,
      'appearance.language': 'xx',
      'diagnostics.logLevel': 5,
      'diagnostics.logSizeMB': 'x',
    }),
    'interpreters.json': JSON.stringify({ version: 2, probes: { 'py -3': { executable: 5, version: null, mtime: 'x' }, python: null } }),
    'plugin-state.json': JSON.stringify({ disabled: 5 }),
    'plugins/broken-plugin/plugin.json': JSON.stringify({ id: 5, main: { file: 'x.js' }, depends: 7 }),
    [`local-history/${sha16(project)}/index.json`]: JSON.stringify({ version: 1, root: project, files: null, labels: 5 }),
    'semantic/exclusions.json': 'null',
    // A readable header, then records of another shape.
    [`semantic/indexes/${sha16(project)}/index.jsonl`]: [
      { version: 3, backend: 'fake', dim: 256, root: project, vectors: 'vectors-x.bin' },
      ['a.py', { chunks: 5 }], [5, null], ['b.py', { chunks: [null] }], ['c.py', 7],
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    [`semantic/indexes/${sha16(project)}/vectors-x.bin`]: '',
    'database/sources.json': JSON.stringify({ version: 1, sources: 'x' }),
    'installer/servers.json': '"x"',
  });
  const t = await launch({ fixture: 'core', port: 9861, name: 'hostile-state', projectDir: project, userData }).catch((err) => ({ err }));
  if (t.err) check(false, `the IDE starts with values of the wrong kind: ${t.err.message}`);
  else {
    try {
      check(await t.js('ide.root === ' + JSON.stringify(project)), 'the project opens with values of the wrong kind');
      await exercise(t);
      check(true, 'files, run configurations, Database, Local History and Settings open');
      const search = await t.js(`ide.api.invoke('semantic:query', ide.root, 'greet', {}).catch((e) => ({ error: e.message }))`);
      check(search?.ok === true, `semantic search answers with a damaged index (${JSON.stringify(search).slice(0, 120)})`);
      // The welcome screen lists only the recent projects that have a path.
      await t.js(`ide.closeProject()`);
      await t.until(`!document.getElementById('welcome').classList.contains('hidden')`, 'welcome screen');
      const rows = await t.js(`[...document.querySelectorAll('#welcomeRecent .welcome-recent-row')].map((r) => r.dataset.path)`);
      check(rows.length === 2 && rows.includes(project), `welcome lists the two recent projects with a path (${JSON.stringify(rows)})`);
      await noErrors(t, 'wrong kinds');
    } catch (err) {
      check(false, err.message);
    } finally { t.close(); }
  }
}

// ---------- 2. text that is not JSON, and a recent project that was deleted ----------
{
  const garbage = '{"version": 1, "files": {"a.py": [tru\u0000\u00ff\ufffd';
  const userData = userDataWith('userdata-garbage', {
    'settings.json': garbage,
    'interpreters.json': garbage,
    'plugin-state.json': garbage,
    [`local-history/${sha16(project)}/index.json`]: garbage,
    [`semantic/indexes/${sha16(project)}/index.jsonl`]: `${garbage}\n["a.py", {"chunks": 5}]\n`,
    'semantic/exclusions.json': garbage,
    'database/sources.json': garbage,
    'installer/servers.json': garbage,
  });
  const t = await launch({ fixture: 'core', port: 9861, name: 'hostile-state', projectDir: project, userData }).catch((err) => ({ err }));
  if (t.err) check(false, `the IDE starts with stores that are not JSON: ${t.err.message}`);
  else {
    try {
      check(await t.js('ide.root === ' + JSON.stringify(project)), 'the project opens with stores that are not JSON');
      check(existsSync(path.join(userData, 'settings.json.bak')), 'the unreadable settings file is kept as settings.json.bak');
      await exercise(t);
      check(true, 'files, run configurations, Database, Local History and Settings open');
      await noErrors(t, 'not JSON');
    } catch (err) {
      check(false, err.message);
    } finally { t.close(); }
  }
}

// ---------- 3. a network share that does not answer ----------
{
  // On the command line: the window still opens (after at most 3 s) and shows the welcome screen.
  const started = Date.now();
  const t = await launch({ fixture: 'core', port: 9862, name: 'hostile-state', projectDir: DEAD_SHARE }).catch((err) => ({ err }));
  if (t.err) check(false, `the IDE starts with an unreachable share on the command line: ${t.err.message}`);
  else {
    try {
      const ms = Date.now() - started;
      check(ms < 15000 && await t.js(`!ide.root && !document.getElementById('welcome').classList.contains('hidden')`), `an unreachable share on the command line: welcome screen ready in ${ms} ms`);
      // As the last project: the main process keeps answering while the check runs, and the welcome screen is ready
      // within a few seconds.
      await t.js(`localStorage.setItem('lastProject', ${JSON.stringify(DEAD_SHARE)})`);
      await t.cdp('Page.reload');
      const reloaded = Date.now();
      await t.until(`window.api && document.readyState === 'complete'`, 'reloaded page', 10000);
      const ping = await t.js(`(async () => { const t0 = performance.now(); await api.invoke('fs:exists', 'C:\\\\'); return performance.now() - t0; })()`);
      check(ping < 1000, `the main process answers while the last project is checked (${Math.round(ping)} ms)`);
      await t.until('window.__ideReady === true', 'IDE ready after reload', 15000);
      const readyMs = Date.now() - reloaded;
      check(readyMs < 10000 && await t.js(`!ide.root`), `an unreachable last project: welcome screen ready in ${readyMs} ms`);
      await noErrors(t, 'unreachable share');
    } catch (err) {
      check(false, err.message);
    } finally { t.close(); }
  }
}

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
