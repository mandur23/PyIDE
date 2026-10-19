// Install Manager plugin: the tab and its categories, the installables contract (late registration, log, progress,
// failure, cancel, updates), pip installs into a real temp venv, winget installs through the confirmation dialog with
// a fake command runner, portable database status under a temp install root, and Korean UI.
// INSTALLER_REAL=1 also downloads, initializes, starts, queries, stops and removes real portable PostgreSQL and MariaDB.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const REAL = process.env.INSTALLER_REAL === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'pyide-installer-env-'));
const root = path.join(work, 'root');
const runnerLog = path.join(work, 'runner.log');
process.env.PYIDE_INSTALL_ROOT = root;
process.env.PYIDE_DB_DRIVERS = path.join(work, 'db-drivers');
process.env.PYIDE_INSTALLER_RUNNER = path.join(HERE, 'fixtures', 'installer', 'fake-runner.cjs');
process.env.PYIDE_INSTALLER_RUNNER_LOG = runnerLog;

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const card = (id) => `.inst-card[data-id="${id}"]`;
const phase = (t, id) => t.js(`document.querySelector('${card(id)}')?.dataset.phase`);
const text = (t, sel) => t.js(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
const waitPhase = async (t, id, want, ms = 30000) => {
  try {
    await t.until(`document.querySelector('${card(id)}')?.dataset.phase === '${want}'`, `${id} ${want}`, ms);
  } catch (err) {
    const c = await t.js(`(() => { const c = document.querySelector('${card(id)}'); return c && { phase: c.dataset.phase, message: c.querySelector('.inst-message').textContent, log: c.querySelector('.inst-log').textContent.slice(-1500) }; })()`);
    throw new Error(`${err.message}; card: ${JSON.stringify(c)}`);
  }
};
const settled = (t) => t.until(`document.querySelectorAll('.inst-card').length && ![...document.querySelectorAll('.inst-card')].some(c => ['unknown', 'checking'].includes(c.dataset.phase))`, 'status checks settled', 60000);
// Cards can sit below the fold; a click at off-screen coordinates would land on whatever is there instead.
const press = async (t, sel) => {
  await t.until(`!!document.querySelector(${JSON.stringify(sel)})`, sel);
  await t.js(`(document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }), true)`);
  await t.click(sel);
};
const showFilter = async (t, filter) => { await t.click(`.inst-nav[data-filter="${filter}"]`); await t.until(`document.querySelector('.inst-nav.selected')?.dataset.filter === '${filter}'`, `filter ${filter}`); };
const count = (t, filter) => t.js(`Number(document.querySelector('.inst-nav[data-filter="${filter}"] .inst-count')?.textContent)`);
const runnerCalls = () => (existsSync(runnerLog) ? readFileSync(runnerLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const imports = (py, mod) => { try { execFileSync(py, ['-c', `import ${mod}`], { stdio: 'ignore' }); return true; } catch { return false; } };

const venv = path.join(work, 'venv');
execFileSync('py', ['-3', '-m', 'venv', venv]);
const venvPy = path.join(venv, 'Scripts', 'python.exe');
execFileSync(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'tomli'], { stdio: 'inherit' });

let a;
let b;
try {
  a = await launch({ fixture: 'installer/project', port: 9620, name: 'installer' });
  await a.js(`(async () => {
    ide.settings.set('interpreters.extra', [${JSON.stringify(venvPy)}]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(venvPy)});
  })()`);

  await a.press('Ctrl+Shift+A');
  await a.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'Find Action popup');
  await a.type('Install Manager');
  await a.until(`document.querySelector('.popup-item.active')?.textContent.includes('Install Manager')`, 'action listed');
  await a.press('Enter');
  await a.until(`!!document.querySelector('#installManager') && ide.activeTab()?.title === 'Install Manager'`, 'manager tab');
  check(true, 'the InstallManager palette action opens the Install Manager tab');
  await settled(a);
  const counts = { python: await count(a, 'cat:python'), databases: await count(a, 'cat:databases'), system: await count(a, 'cat:system'), all: await count(a, 'all') };
  // Other plugins add their own pip items (rope, coverage, pandas...), so Python Tools has at least the eight built in.
  check(counts.python >= 8 && counts.databases === 2 && counts.system === 3 && counts.all >= 13, `categories render with counts ${JSON.stringify(counts)}`);
  const aiIds = await a.js(`ide.installables.filter(i => i.category === 'ai').map(i => i.id).sort().join(',')`);
  check(aiIds === 'ai:claude-code,ai:embeddinggemma-2,ai:qwen2.5-coder-0.5b,ai:qwen2.5-coder-1.5b' && await count(a, 'cat:ai') === 4, `EmbeddingGemma 2, Claude Code and the completion models are listed under AI Models (${aiIds})`);
  check(await count(a, 'cat:drivers') === 2, 'the database plugin lists its PostgreSQL and MySQL drivers');

  // ---------- installables contract ----------
  await a.js(`(() => {
    window.__t = {};
    const state = { ok: false, upd: '1.0' };
    (ide.installables ||= []).push(
      { id: 'test:ok', category: 'testing', name: 'Test Tool', description: 'Installs in two steps.',
        status: async () => ({ installed: state.ok, version: state.ok ? '1.0' : undefined }),
        install: async (log, progress) => {
          log('step one');
          progress(0.5);
          await new Promise((r) => { window.__t.release = r; });
          log('step two');
          progress(1);
          state.ok = true;
        } },
      { id: 'test:fail', category: 'testing', name: 'Broken Tool', description: 'Always fails.',
        status: async () => ({ installed: false }),
        install: async (log) => { log('starting'); throw new Error('disk is full'); } },
      { id: 'test:cancel', category: 'testing', name: 'Slow Tool', description: 'Never finishes.',
        status: async () => ({ installed: false }),
        install: (log, progress, signal) => new Promise((_, reject) => { log('waiting'); signal.addEventListener('abort', () => { window.__t.aborted = true; reject(new Error('aborted')); }); }) },
      { id: 'test:upd', category: 'testing', name: 'Old Tool', description: 'Has an update.',
        status: async () => ({ installed: true, version: state.upd, update: state.upd === '1.0' ? '2.0' : undefined }),
        install: async () => {},
        update: async (log) => { log('updating'); state.upd = '2.0'; } },
      { id: 42 },
    );
    ide.emit('installablesChanged');
    return true;
  })()`);
  await a.until(`!!document.querySelector('.inst-nav[data-filter="cat:testing"]')`, 'testing category');
  check(await count(a, 'cat:testing') === 4, 'installables registered after load appear in their own category (an invalid entry is ignored)');
  await showFilter(a, 'cat:testing');
  await settled(a);
  check(await phase(a, 'test:ok') === 'notInstalled', 'a registered item is checked and shows Not installed');
  check(await count(a, 'updates') >= 1 && (await text(a, `${card('test:upd')} button[data-op="update"]`)).includes('2.0'), 'an item reporting an update is counted under Updates and offers Update to 2.0');

  await press(a, `${card('test:ok')} button[data-op="install"]`);
  await a.until(`window.__t.release && document.querySelector('${card('test:ok')} .inst-log').textContent.includes('step one')`, 'first log line');
  const mid = await a.js(`(() => { const c = document.querySelector('${card('test:ok')}'); return { phase: c.dataset.phase, width: c.querySelector('.inst-bar').style.width, cancel: !!c.querySelector('button[data-op="cancel"]'), status: document.querySelector('#installerStatus').textContent }; })()`);
  check(mid.phase === 'installing' && mid.width === '50%' && mid.cancel, `install streams log and progress while running ${JSON.stringify(mid)}`);
  check(mid.status.includes('1'), 'the status bar shows a running job');
  await a.js(`(window.__t.release(), true)`);
  await waitPhase(a, 'test:ok', 'installed');
  await a.until(`document.querySelector('${card('test:ok')} .inst-log').textContent.includes('step two')`, 'second log line');
  check((await text(a, `${card('test:ok')} .inst-version`)) === 'v1.0', 'after install the status flips to Installed with its version');

  await press(a, `${card('test:fail')} button[data-op="install"]`);
  await waitPhase(a, 'test:fail', 'failed');
  check((await text(a, `${card('test:fail')} .inst-message`)).includes('disk is full') && !!(await a.js(`!!document.querySelector('${card('test:fail')} button[data-op="install"]')`)), 'a failed install shows the error and can be retried');

  await press(a, `${card('test:cancel')} button[data-op="install"]`);
  await waitPhase(a, 'test:cancel', 'installing');
  await press(a, `${card('test:cancel')} button[data-op="cancel"]`);
  await waitPhase(a, 'test:cancel', 'notInstalled');
  check(await a.js(`window.__t.aborted === true`) && (await text(a, `${card('test:cancel')} .inst-log`)).includes('Cancelled.'), 'Cancel aborts the job and returns to Not installed');

  await press(a, `${card('test:upd')} button[data-op="update"]`);
  await a.until(`document.querySelector('${card('test:upd')} .inst-version')?.textContent === 'v2.0'`, 'updated');
  check(await count(a, 'updates') === 0 || !(await a.js(`!!document.querySelector('${card('test:upd')} button[data-op="update"]')`)), 'Update runs and the update offer goes away');
  check(await count(a, 'installed') >= 2, 'the Installed filter counts installed items');
  await a.shot('contract.png');

  // ---------- Python tools in a real venv ----------
  await a.js(`(ide.installer.register(ide.installer.pip({ package: 'tomli', description: 'TOML parser' })), ide.installer.register(ide.installer.pip({ package: 'six', description: 'Python 2 and 3 compatibility' })), true)`);
  await showFilter(a, 'cat:python');
  await settled(a);
  check((await text(a, '.inst-target')).includes(path.basename(path.dirname(path.dirname(venvPy)))) || (await text(a, '.inst-target')).length > 0, 'the Python category names the target interpreter');
  check(await phase(a, 'pip:ruff') === 'notInstalled', 'ruff is not installed in the fresh venv');
  const tomliVersion = execFileSync(venvPy, ['-c', 'import importlib.metadata as m; print(m.version("tomli"))'], { encoding: 'utf8' }).trim();
  check(await phase(a, 'pip:tomli') === 'installed' && (await text(a, `${card('pip:tomli')} .inst-version`)) === `v${tomliVersion}`, `tomli already in the venv is detected with its version (${tomliVersion})`);
  await press(a, `${card('pip:six')} button[data-op="install"]`);
  await waitPhase(a, 'pip:six', 'installed', 180000);
  check((await text(a, `${card('pip:six')} .inst-log`)).includes('Successfully installed six') && imports(venvPy, 'six'), 'Install runs pip with a live log and six is really importable in the venv');
  await press(a, `${card('pip:six')} button[data-op="uninstall"]`);
  await waitPhase(a, 'pip:six', 'notInstalled', 120000);
  check(!imports(venvPy, 'six'), 'Remove uninstalls six from the venv');

  // ---------- system tools via winget (fake runner) ----------
  await showFilter(a, 'cat:system');
  await settled(a);
  check(await phase(a, 'system:git') === 'notInstalled', 'Git shows Not installed under the fake runner');
  await press(a, `${card('system:git')} button[data-op="install"]`);
  await a.until(`document.querySelector('.dialog')?.textContent.includes('winget install --id Git.Git')`, 'winget confirmation');
  check(true, 'installing a system tool asks for confirmation and shows the winget command');
  await a.click('.dialog .secondary');
  await a.until(`!document.querySelector('.dialog')`, 'dialog closed');
  check(!runnerCalls().some((c) => c.args[0] === 'install'), 'declining the dialog runs nothing');
  await press(a, `${card('system:git')} button[data-op="install"]`);
  await a.until(`!!document.querySelector('.dialog')`, 'dialog again');
  await a.click('.dialog .primary');
  await waitPhase(a, 'system:git', 'installed');
  const install = runnerCalls().find((c) => c.args[0] === 'install');
  const expected = ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements'];
  check(install?.cmd === 'winget' && JSON.stringify(install.args) === JSON.stringify(expected), `winget ran with the exact arguments ${JSON.stringify(install)}`);
  check((await text(a, `${card('system:git')} .inst-version`)) === 'v2.51.0', 'Git is detected as installed afterwards');
  await press(a, `${card('system:node')} button[data-op="install"]`);
  await a.until(`!!document.querySelector('.dialog')`, 'node dialog');
  await a.click('.dialog .primary');
  await a.until(`document.querySelector('${card('system:node')} .inst-log')?.textContent.includes('Found OpenJS.NodeJS.LTS')`, 'node job running');
  await press(a, `${card('system:python313')} button[data-op="install"]`);
  await a.until(`!!document.querySelector('.dialog')`, 'python dialog');
  await a.click('.dialog .primary');
  await a.until(`document.querySelector('${card('system:python313')} .inst-log')?.textContent.includes('Waiting for another job')`, 'python queued');
  check(await phase(a, 'system:python313') === 'installing' && !runnerCalls().some((c) => c.args.includes('Python.Python.3.13')), 'a second winget job waits in the queue behind the running one');
  await press(a, `${card('system:node')} button[data-op="cancel"]`);
  await waitPhase(a, 'system:node', 'notInstalled');
  check((await text(a, `${card('system:node')} .inst-log`)).includes('Cancelled.'), 'cancelling a main-process job stops it');
  await waitPhase(a, 'system:python313', 'installed');
  check((await text(a, `${card('system:python313')} .inst-version`)) === 'v3.13.9', 'the queued job runs once the lane is free');
  await a.shot('system.png');

  // ---------- portable databases ----------
  await showFilter(a, 'cat:databases');
  await settled(a);
  const db = await a.js(`['server:postgresql', 'server:mariadb'].map((id) => { const c = document.querySelector('.inst-card[data-id="' + id + '"]'); return [c.dataset.phase, c.querySelector('.inst-version').textContent, c.querySelector('.inst-meta').textContent]; })`);
  check(db[0][0] === 'notInstalled' && db[0][1] === 'v18.6' && db[0][2].includes('367 MB'), `PostgreSQL shows Not installed under the temp root ${JSON.stringify(db[0])}`);
  check(db[1][0] === 'notInstalled' && db[1][1] === 'v11.8.9' && db[1][2].includes('93 MB'), `MariaDB shows Not installed under the temp root ${JSON.stringify(db[1])}`);
  check(!existsSync(path.join(root, 'servers')), 'checking status writes nothing to the install root');
  await a.shot('databases.png');

  if (REAL) {
    const SERVERS = [
      { name: 'postgresql', title: 'PostgreSQL', driver: 'db-driver-postgres', bin: path.join(root, 'servers', 'postgresql-18.6', 'pgsql', 'bin'),
        ping: (bin, c) => [path.join(bin, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(c.port)], {}],
        query: (bin, c) => [path.join(bin, 'psql.exe'), ['-h', '127.0.0.1', '-p', String(c.port), '-U', c.user, '-d', c.database, '-tAc', 'select 40 + 2'], { PGPASSWORD: c.password }] },
      { name: 'mariadb', title: 'MariaDB', driver: 'db-driver-mysql', bin: path.join(root, 'servers', 'mariadb-11.8.9', 'mariadb-11.8.9-winx64', 'bin'),
        ping: (bin, c) => [path.join(bin, 'mariadb-admin.exe'), ['-h', '127.0.0.1', '-P', String(c.port), '-u', c.user, `--password=${c.password}`, 'ping'], {}],
        query: (bin, c) => [path.join(bin, 'mariadb.exe'), ['-h', '127.0.0.1', '-P', String(c.port), '-u', c.user, `--password=${c.password}`, '-N', '-B', '-e', 'select 40 + 2', c.database], {}] },
    ];
    const run = ([cmd, args, env]) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    for (const s of SERVERS) {
      const id = `server:${s.name}`;
      await press(a, `${card(id)} button[data-op="install"]`);
      await waitPhase(a, id, 'installed', 40 * 60000);
      check(true, `${s.title} downloads, verifies its sha256, extracts and initializes`);
      await press(a, `${card(id)} button[data-op="start"]`);
      await waitPhase(a, id, 'running', 120000);
      const conn = await a.js(`ide.api.invoke('installer:serverConnection', '${s.name}')`);
      check(run(s.ping(s.bin, conn)).length > 0, `${s.title} answers a ping on port ${conn.port}`);
      check(run(s.query(s.bin, conn)) === '42', `${s.title} accepts a query with the generated password`);
      const actions = await a.js(`[...document.querySelectorAll('${card(id)} button[data-op="action"]')].map((b) => b.textContent)`);
      const withDb = await a.js(`typeof ide.database?.addDataSource === 'function'`);
      check(actions.includes('Copy Connection URL') && actions.includes('Add as Data Source') === withDb, `a running server offers its actions ${JSON.stringify(actions)}`);
      await showFilter(a, 'cat:drivers');
      await press(a, `${card(s.driver)} button[data-op="install"]`);
      await waitPhase(a, s.driver, 'installed', 10 * 60000);
      await showFilter(a, 'cat:databases');
      const before = await a.js(`ide.database.list().length`);
      await a.js(`[...document.querySelectorAll('${card(id)} button[data-op="action"]')].find((b) => b.textContent === 'Add as Data Source').click()`);
      await a.until(`ide.database.list().length === ${before + 1}`, 'data source added');
      const answer = await a.js(`(async () => { const src = ide.database.list().at(-1); const r = await ide.database.query(src.id, 'select 40 + 2 as answer'); return r.ok ? String(r.rows[0][0]) : r.error; })()`);
      check(answer === '42', `Add as Data Source connects the Database plugin to the new ${s.title} server (${answer})`);      await press(a, `${card(id)} button[data-op="stop"]`);
      await waitPhase(a, id, 'installed', 60000);
      let down = false;
      try { run(s.ping(s.bin, conn)); } catch { down = true; }
      check(down, `Stop shuts ${s.title} down`);
      await a.until(`ide.database.list().at(-1)?.state === 'error'`, 'connection lost state', 30000).catch(() => {});
      const lost = await a.js(`ide.database.list().at(-1)`);
      check(lost.state === 'error' && /Connection lost/.test(lost.message || ''), `stopping ${s.title} under an open connection marks the data source as lost instead of crashing (${lost.state}: ${lost.message})`);
      check(!/[�]/.test(await a.js(`document.querySelector('${card(id)} .inst-log').textContent`)), `${s.title} tool output is decoded without replacement characters`);      await press(a, `${card(id)} button[data-op="uninstall"]`);
      await a.until(`!!document.querySelector('.dialog')`, 'remove confirmation');
      await a.click('.dialog .primary');
      await waitPhase(a, id, 'notInstalled', 120000);
      check(!readdirSync(path.join(root, 'servers')).some((d) => d.startsWith(s.name)), `Remove deletes the ${s.title} directory`);
    }
  }

  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${JSON.stringify(a.consoleErrors)}` : ''}`);
  await a.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  a.close();

  // ---------- Korean ----------
  b = await launch({ fixture: 'installer/project', port: 9621, name: 'installer-ko', lang: 'ko-KR', userData: a.userData });
  await b.js(`(ide.runAction('InstallManager'), true)`);
  await b.until(`!!document.querySelector('#installManager')`, 'manager tab (ko)');
  await settled(b);
  const leaks = [];
  for (const f of ['all', 'cat:python', 'cat:databases', 'cat:system']) {
    await showFilter(b, f);
    await settled(b);
    leaks.push(...await englishLeaks(b, '#installManager', ['PostgreSQL', 'MariaDB', 'MySQL', 'EDB', 'Rust', 'Black', 'npm', 'winget', 'JavaScript', 'zip', 'URL']));
  }
  check(!leaks.length, `Install Manager UI is in Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  check((await text(b, '.inst-nav[data-filter="cat:python"]')).includes('Python 도구'), 'categories are translated');
  await b.shot('korean.png');
  await showFilter(b, 'cat:system');
  await press(b, `${card('system:node')} button[data-op="install"]`);
  await b.until(`!!document.querySelector('.dialog')`, 'ko dialog');
  const dialogLeaks = await englishLeaks(b, '.dialog', ['winget', 'PATH', 'PyIDE']);
  check(!dialogLeaks.length, `the winget confirmation is in Korean${dialogLeaks.length ? ` ${JSON.stringify(dialogLeaks)}` : ''}`);
  await b.shot('korean-dialog.png');
  await b.click('.dialog .secondary');
  check(b.consoleErrors.length === 0, 'no renderer exceptions (ko)');
  b.close();
} catch (err) {
  check(false, err.message);
  a?.close();
  b?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
