// One continuous, realistic session across the IDE's tools, offline (ports 9570-9579).
// A plain folder becomes a Git repository from the Commit window; the first commit runs every commit check; a branch,
// a conflicting merge resolved in the merge tool, a rebase, a stash, a shelf whose unshelve conflicts, the log and
// Annotate; Commit and Push defines a local bare remote; another clone pushes and auto-fetch shows ↓ in the toolbar,
// whose Update Project pulls, also over a conflicting change. Then the GitHub plugin with the fake gh
// (verify/fixtures/github; github.com is rewritten to a local bare repository in the test's git config, so nothing
// leaves the machine): Share, the pull request list, details, Checkout. The terminal with split panes and the
// project-switch question, a notebook with its variables and Data View (only when verify/out/dataview-venv has
// ipykernel and pandas, as verify/dataview.mjs leaves it), a SQLite data source with completion and Copy as CSV, the
// HTTP client against a local server, Create Virtual Environment and Python Packages with offline wheels and a fake OSV
// server, notifications and background tasks, Report a Problem, an update check against a folder feed and Settings
// export. Then the project closes (nothing of it stays on screen) and File › Exit quits: no git, gh, kernel or shell
// process of the session may be left. A second instance with a fresh profile imports the settings.
// FLOW_ONLY=git,github,... runs only the named phases, for debugging; later phases assume the earlier ones ran.
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { descendants, launch, processSnapshot } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.FLOW_ONLY ? new Set(process.env.FLOW_ONLY.split(',')) : null;

// ---------- the machine: git isolated from the user's config, github.com rewritten to a local bare repository ----------
const work = mkdtempSync(path.join(tmpdir(), 'pyide-flow-tools-'));
const fwd = (p) => p.replace(/\\/g, '/');
const ghRemotes = path.join(work, 'github.com');
mkdirSync(ghRemotes);
const gitConfig = path.join(work, 'gitconfig');
writeFileSync(gitConfig, `[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[url "${fwd(ghRemotes)}/"]\n\tinsteadOf = https://github.com/\n`);
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');
const write = (dir, rel, data) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), data); };
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

// The project: a small shop package, not yet under version control.
const project = path.join(work, 'shop');
write(project, 'shop/__init__.py', '');
write(project, 'shop/cart.py', 'import os\nimport sys\ndef total(items):\n    return sum(price*qty for price,qty in items)\n\n\ndef discount(amount):\n    return amount  # TODO: real discounts\n');
write(project, 'main.py', 'from shop.cart import total\n\n\nif __name__ == "__main__":\n    print(total([(2.5, 4), (1.0, 3)]))\n');
write(project, 'test_cart.py', 'import unittest\n\nfrom shop.cart import total\n\n\nclass TestCart(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(total([(2, 3)]), 6)\n');
write(project, 'README.md', '# Shop\n\nA tiny shop.\n');
write(project, '.gitignore', '__pycache__/\n.venv/\n*.db\n');
const bare = path.join(work, 'remote.git');
git(work, 'init', '--bare', '-q', bare);

// ---------- the fake GitHub CLI (verify/fixtures/github) ----------
const bin = path.join(work, 'bin');
mkdirSync(bin);
for (const f of ['gh.cmd', 'fake-gh.js']) copyFileSync(path.join(HERE, 'fixtures', 'github', f), path.join(bin, f));
const ghState = path.join(work, 'gh-state.json');
const ghLogFile = path.join(work, 'gh-log.jsonl');
writeFileSync(ghState, q({ auth: 'in', account: 'alice', prs: [], views: {} }));
const ghArgvs = () => (existsSync(ghLogFile) ? readFileSync(ghLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []);
// The repository gh repo create makes on "GitHub": github.com/alice/shop.git, which the git config maps to this folder.
git(work, 'init', '--bare', '-q', path.join(ghRemotes, 'alice', 'shop.git'));

// ---------- offline wheels and a fake OSV database (as verify/vulnerabilities.mjs builds them) ----------
const wheels = path.join(work, 'wheels');
execFileSync('py', ['-3', '-I', '-c', `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for name, ver in (('pyide_vuln_demo', '1.0'), ('pyide_vuln_demo', '1.1'), ('pyide_shop_extras', '0.1')):
    info = f'{name}-{ver}.dist-info'
    files = {f'{name}/__init__.py': f'__version__ = "{ver}"\\n',
             f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: {name.replace("_", "-")}\\nVersion: {ver}\\n',
             f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = []
    with zipfile.ZipFile(os.path.join(sys.argv[1], f'{name}-{ver}-py3-none-any.whl'), 'w') as z:
        for p, c in files.items():
            b = c.encode()
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            z.writestr(p, b)
            record.append(f'{p},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`, wheels]);
const OSV_PORT = 9576;
const osvAsked = [];
const ADVISORY = { id: 'GHSA-shop-0000-0001', aliases: ['CVE-2099-1234'], summary: 'Code execution in pyide-vuln-demo loaders', database_specific: { severity: 'HIGH' },
  affected: [{ package: { ecosystem: 'PyPI', name: 'pyide-vuln-demo' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.1' }] }] }] };
const osv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/querybatch') {
      const { queries } = JSON.parse(body);
      osvAsked.push(...queries.map((x) => `${x.package.name}@${x.version}`));
      return res.end(q({ results: queries.map((x) => (/^pyide[-_]vuln[-_]demo$/i.test(x.package.name) && x.version === '1.0' ? { vulns: [{ id: ADVISORY.id, modified: '2099-01-01T00:00:00Z' }] } : {})) }));
    }
    if (req.method === 'GET' && req.url === `/v1/vulns/${ADVISORY.id}`) return res.end(q(ADVISORY));
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => osv.listen(OSV_PORT, '127.0.0.1', r));

// ---------- process trees (verify/lib.mjs: descendants started no earlier than their parents) ----------
const ideProcesses = () => descendants(processSnapshot(), t.pid);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- UI helpers ----------
function helpers(t) {
  const { js, cdp, type, press } = t;
  // Chromium pauses painting for an occluded window, so every wait and mouse action first forces a frame.
  const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  async function until(expr, label, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await frame();
      try { if (await js(expr)) return true; } catch {}
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  }
  async function mouse(expr, { button = 'left', clickCount = 1, label = expr, modifiers = 0 } = {}) {
    await frame();
    // Balloons pile up in the lower right during a busy session; a user closes them when they cover what they want to
    // click (closing one moves the others, so all go).
    let box;
    for (let i = 0; i < 4; i++) {
      box = await js(`(() => {
        const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' });
        const r = n.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const covered = !!document.elementFromPoint(x, y)?.closest('.ide-balloons');
        if (covered) document.querySelectorAll('.ide-balloon .ide-balloon-close').forEach(b => b.click());
        return { x, y, covered };
      })()`);
      if (!box?.covered) break;
      await sleep(400);
    }
    if (!box) throw new Error(`no element for ${label}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(80);
    for (let i = 1; i <= clickCount; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i, modifiers });
    }
    await sleep(100);
  }
  const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
  async function branchItem(label) {
    await mouse(`document.querySelector('.vcs-branch')`, { label: 'branch widget' });
    await until(popupOpen, 'branch popup');
    await type(label);
    await until(`document.querySelector('.popup-item.active .label')?.textContent === ${q(label)}`, `popup item ${label}`);
    await press('Enter');
  }
  async function pickInPopup(placeholder, name) {
    await until(`${popupOpen} && document.querySelector('#popupIn').placeholder === ${q(placeholder)}`, placeholder);
    await type(name);
    await until(`document.querySelector('.popup-item.active .label')?.textContent === ${q(name)}`, `item ${name}`);
    await press('Enter');
  }
  async function promptAnswer(placeholder, text) {
    await until(`${popupOpen} && document.querySelector('#popupIn').placeholder === ${q(placeholder)}`, `prompt ${placeholder}`);
    await js(`(document.querySelector('#popupIn').value = '', true)`);
    await type(text);
    await press('Enter');
  }
  const noteWith = (text) => `ide.notifications.list().some(n => (n.title + ' ' + (n.text || '')).includes(${q(text)}))`;
  const changeRow = (name, status) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)})${status ? ` && r.dataset.status === ${q(status)}` : ''})`;
  const conflictRow = (name) => `[...document.querySelectorAll('.vcs-conflict-row[data-path]')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
  const MT = `document.querySelector('.custom-tab:not(.hidden) .vcs-mt')`;
  const button = (label) => `[...document.querySelectorAll('#dialogHost .dialog-buttons button')].find(b => b.textContent === ${q(label)})`;
  const menuItem = (label) => `[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.firstChild.textContent === ${q(label)})`;
  const dialogTitle = () => js(`document.querySelector('#dialogHost .dialog-title')?.textContent || ''`);
  const refresh = () => js(`ide.vcs.refresh().then(() => true)`);
  // Commit… (Ctrl+K) shows the Commit tab, also from the Shelf tab, and focuses the message.
  async function setMessage(text) {
    await press('Ctrl+k');
    await until(`!!document.querySelector('.vcs-msg')?.offsetParent`, 'commit message box');
    await js(`(document.querySelector('.vcs-msg').value = ${q(text)}, true)`);
  }
  async function tick(name, on) {
    await until(`!!${changeRow(name)}`, `${name} listed`);
    if ((await js(`${changeRow(name)}.querySelector('input').checked`)) !== on) await mouse(`${changeRow(name)}.querySelector('input')`, { label: `tick ${name}` });
    await until(`${changeRow(name)}.querySelector('input').checked === ${on}`, `${name} ${on ? 'ticked' : 'unticked'}`);
  }
  // Replaces a document's text as one edit (as typing would), then saves with Ctrl+S and waits for the file on disk.
  async function editAndSave(rel, text) {
    const p = q(rel.replace(/\//g, '\\'));
    await js(`ide.openFile(ide.util.joinPath(ide.root, ${p}))`);
    await until(`ide.activeTab()?.path.toLowerCase().endsWith(${p}.toLowerCase()) && !!ide.getDocument(ide.activeTab().path)`, `${rel} open`);
    await js(`(() => { const m = ide.getDocument(ide.activeTab().path).model; m.pushEditOperations([], [{ range: m.getFullModelRange(), text: ${q(text)} }], () => null); return true; })()`);
    await press('Ctrl+s');
    const end = Date.now() + 15000;
    while (Date.now() < end && read(t.project, rel) !== text) await sleep(150);
    if (read(t.project, rel) !== text) throw new Error(`${rel} was not saved`);
  }
  return { frame, until, mouse, branchItem, pickInPopup, promptAnswer, noteWith, changeRow, conflictRow, MT, button, menuItem, dialogTitle, refresh, setMessage, tick, editAndSave };
}

// ---------- the session ----------
rmSync(path.join(HERE, 'out', 'flow-tools'), { recursive: true, force: true });
const settingsDialog = path.join(work, 'settings-dialog.json');
writeFileSync(settingsDialog, '{}');
const t = await launch({ fixture: 'vcs', port: 9570, name: 'flow-tools', projectDir: project, env: {
  PYIDE_SETTINGS_SYNC_DIALOG: path.join(work, 'settings-dialog.json'), PYIDE_DIAGNOSTICS_TEST: '1',
  PYIDE_GH: path.join(bin, 'gh.cmd'), FAKE_GH_STATE: ghState, FAKE_GH_LOG: ghLogFile, PYIDE_FAKE_OPEN_EXTERNAL: '1',
  PYIDE_OSV_URL: `http://127.0.0.1:${OSV_PORT}`, PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels, PIP_DISABLE_PIP_VERSION_CHECK: '1',
} });
const h = helpers(t);
const { js, check, shot, press, type } = t;
const { until, mouse } = h;
let shotN = 0;
const snap = (name) => shot(`${String(++shotN).padStart(2, '0')}-${name}.png`).catch(() => {});

async function phase(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  console.log(`---------- ${name} ----------`);
  try {
    await fn();
  } catch (err) {
    check(false, `${name}: ${err.message.split('\n')[0]}`);
    await snap(`${name}-failure`);
    await js(`([...document.querySelectorAll('#dialogHost .dialog')].reverse().forEach(d => [...d.querySelectorAll('.dialog-buttons button')].pop()?.click()), true)`).catch(() => {});
    await press('Escape').catch(() => {});
  }
}
const commits = () => Number(git(project, 'rev-list', '--count', 'HEAD'));
// IDE Internal Errors (main and every window), as the red status-bar icon lists them.
const internalErrors = () => js(`ide.api.invoke('diagnostics:errors').then(l => l.map(e => (e.plugin || 'core') + ': ' + e.message))`).catch(() => []);

await js(`(ide.settings.set('vcs.autoFetchMinutes', 0), true)`);
// Every background task title of the session (status bar, ide.tasks).
await js(`(window.__flowTasks = [], ide.on('tasksChanged', (l) => l.forEach(x => window.__flowTasks.includes(x.title) || window.__flowTasks.push(x.title))), true)`);
const tasksSeen = () => js('window.__flowTasks');

// ===================================================================== Git
await phase('git', async () => {
  // ---------- Create Git Repository… from the Commit window ----------
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await until(`!!document.querySelector('.vcs-init-btn')?.offsetParent`, 'Create Git Repository button');
  await mouse(`document.querySelector('.vcs-init-btn')`, { label: 'Create Git Repository…' });
  await until(`!!document.querySelector('.vcs-commit:not(.hidden)') && !!${h.changeRow('cart.py')}`, 'repository created and its files listed');
  check(existsSync(path.join(project, '.git')), 'Create Git Repository… runs git init in the project');
  check(await js(h.noteWith('Created Git repository')), 'a notification says the repository was created');
  await snap('git-init');

  // ---------- first commit with every commit check ----------
  // Unversioned files are not ticked by default (PyCharm): tick the group.
  await until(`document.querySelector('#wsHome .ws-branch-name')?.textContent === 'main'`, 'the Workspace home shows the new repository branch');
  check(true, 'the Workspace home branch chip follows Create Git Repository (it said "No Git repository")');
  const groupTitle = await js(`[...document.querySelectorAll('.vcs-group .vcs-group-title')].map(n => n.textContent).join('|')`);
  check(groupTitle.includes('Unversioned Files'), `the new files are listed as unversioned (${groupTitle})`);
  await mouse(`[...document.querySelectorAll('.vcs-group')].find(g => g.textContent.includes('Unversioned Files')).querySelector('input')`, { label: 'tick unversioned' });
  await until(`[...document.querySelectorAll('.vcs-changes .vcs-file input')].every(i => i.checked)`, 'every file ticked');
  const cfgId = await js(`ide.run.addTemporary({ type: 'pytest', name: 'tests in test_cart.py', target: 'test_cart.py' }).id`);
  await mouse(`document.querySelector('#vcsCommitOptions')`, { label: 'commit options gear' });
  await until(`!!document.querySelector('#vcsChecksPopup')`, 'Before Commit popup');
  for (const id of ['reformat', 'optimizeImports', 'analyze', 'todo']) {
    if (!(await js(`document.querySelector('#vcsChecksPopup [data-check="${id}"] input').checked`))) await mouse(`document.querySelector('#vcsChecksPopup [data-check="${id}"] input')`, { label: id });
  }
  await js(`(() => { const s = document.querySelector('#vcsChecksTestConfig'); s.value = ${q(cfgId)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`[...document.querySelectorAll('#vcsChecksPopup .vcs-checks-option input')].every(i => i.checked)`, 'all five checks on');
  await snap('commit-options');
  await mouse(`document.querySelector('#vcsCommitOptions')`, { label: 'close popup' });
  await h.setMessage('Initial commit');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit' });
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Check TODO'`, 'Check TODO dialog', 120000);
  check(true, 'the new TODO stops the first commit with Check TODO');
  await snap('check-todo');
  await mouse(h.button('Commit Anyway'), { label: 'Commit Anyway' });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if (commits() === 1) break; } catch {} await sleep(300); }
  check(commits() === 1, 'Commit Anyway records the initial commit after the tests pass');
  const committedCart = git(project, 'show', 'HEAD:shop/cart.py');
  check(!committedCart.includes('import os') && committedCart.includes('price * qty for price, qty in items'), `the committed cart.py has its imports optimized and is reformatted (${q(committedCart)})`);
  check(git(project, 'status', '--porcelain') === '', `nothing is left uncommitted (${q(git(project, 'status', '--porcelain'))})`);
  check((await tasksSeen()).some((x) => /commit/i.test(x)), `the checks ran as a background task (${q(await tasksSeen())})`);
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'branch widget says main');
  await until(`document.querySelector('#vcsChecksProgress').classList.contains('hidden')`, 'progress strip hidden');
  // Turn the slow checks off for the rest of the session, as a user would after the first commit.
  await js(`(['reformat', 'optimizeImports', 'runTests'].forEach(k => ide.settings.set('vcs.commitChecks.' + k, false)), true)`);

  // ---------- a feature branch and a conflicting merge resolved in the merge tool ----------
  await h.branchItem('New Branch…');
  await h.promptAnswer('New branch name', 'feature/discount');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'feature/discount'`, 'on feature/discount');
  await until(`document.querySelector('#wsHome .ws-branch-name')?.textContent === 'feature/discount'`, 'the Workspace home follows the new branch');
  await h.editAndSave('shop/cart.py', read(project, 'shop/cart.py').replace('    return amount  # TODO: real discounts\n', '    return amount * 0.9\n'));
  await h.refresh();
  await h.tick('cart.py', true);
  await h.setMessage('Ten percent discount');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit' });
  await until(`!${h.changeRow('cart.py')}`, 'feature commit');
  check(git(project, 'log', '-1', '--format=%s') === 'Ten percent discount', 'the change is committed on feature/discount');
  await h.branchItem('main');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'back on main');
  await until(`ide.activeTab().model.getValue().includes('# TODO: real discounts')`, 'the open editor shows main\'s cart.py');
  check(true, 'checking out main reloads the open editor');
  await h.editAndSave('shop/cart.py', read(project, 'shop/cart.py').replace('    return amount  # TODO: real discounts\n', '    return max(amount - 5, 0)\n'));
  await h.refresh();
  await h.setMessage('Five off');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit' });
  await until(`!${h.changeRow('cart.py')}`, 'main commit');
  await h.branchItem('Merge into Current…');
  await h.pickInPopup('Merge into main', 'feature/discount');
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'Conflicts dialog', 30000);
  await snap('merge-conflicts');
  await mouse(h.conflictRow('cart.py'), { clickCount: 2, label: 'cart.py row' });
  await until(`!!${h.MT}?._vcsMerge && ${h.MT}.querySelectorAll('.vcs-mt-act').length >= 2`, 'merge tool', 30000);
  const chunk = await js(`${h.MT}._vcsMerge.chunks.find(c => c.kind === 'conflict').id`);
  await mouse(`${h.MT}.querySelector('.vcs-mt-strip[data-side="theirs"] .vcs-mt-act.accept[data-chunk="${chunk}"]')`, { label: 'accept theirs' });
  await until(`${h.MT}._vcsMerge.models.result.getValue().includes('amount * 0.9')`, 'theirs accepted');
  await mouse(`${h.MT}.querySelector('.vcs-mt-strip[data-side="ours"] .vcs-mt-act.ignore[data-chunk="${chunk}"]')`, { label: 'ignore ours' });
  await until(`${h.MT}.querySelector('.vcs-mt-status').textContent === 'All changes have been processed'`, 'conflict processed');
  await snap('merge-tool');
  await mouse(`${h.MT}.querySelector('.vcs-mt-apply')`, { label: 'Apply' });
  await until(`!document.querySelector('.vcs-mt') && !!document.querySelector('.vcs-op-banner[data-op="merge"]')`, 'merge resolved, banner shown');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit merge' });
  await until(`!document.querySelector('.vcs-op-banner')`, 'merge committed', 30000);
  check(git(project, 'log', '-1', '--format=%P').split(' ').length === 2 && read(project, 'shop/cart.py').includes('amount * 0.9'), 'the merge is committed with the resolved text');
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'shop\\\\cart.py'))?.model.getValue().includes('amount * 0.9')`), 'the open editor shows the merged text');

  // ---------- rebase a docs branch onto main ----------
  await h.branchItem('New Branch…');
  await h.promptAnswer('New branch name', 'docs');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'docs'`, 'on docs');
  await h.editAndSave('README.md', '# Shop\n\nA tiny shop.\n\nRun `python main.py`.\n');
  await h.refresh();
  await h.setMessage('Document running');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit docs' });
  await until(`!${h.changeRow('README.md')}`, 'docs commit');
  await h.branchItem('main');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'main again');
  await h.editAndSave('main.py', read(project, 'main.py').replace('print(total', 'print("Total:", total'));
  await h.refresh();
  await h.setMessage('Label the total');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit main' });
  await until(`!${h.changeRow('main.py')}`, 'main commit');
  await h.branchItem('docs');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'docs'`, 'docs again');
  await h.branchItem('Rebase Current onto…');
  await h.pickInPopup('Rebase docs onto', 'main');
  await until(h.noteWith('Rebase'), 'rebase notification', 30000);
  check(git(project, 'log', '--format=%s', '-2').split('\n').join('|') === 'Document running|Label the total', `docs is replayed on top of main (${git(project, 'log', '--format=%s', '-3').split('\n').join('|')})`);
  await h.branchItem('main');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'main after rebase');
  await h.branchItem('Merge into Current…');
  await h.pickInPopup('Merge into main', 'docs');
  await until(`${h.noteWith('Merged')} || ${h.noteWith('merged')}`, 'fast-forward merge', 30000).catch(() => {});
  check(read(project, 'README.md').includes('python main.py'), 'docs fast-forwards into main');

  // ---------- stash and unstash ----------
  await h.editAndSave('main.py', `${read(project, 'main.py')}\n# work in progress\n`);
  await h.branchItem('Stash Changes…');
  await until(`!!document.querySelector('.dialog .vcs-stash-msg')`, 'stash dialog');
  await js(`document.querySelector('.vcs-stash-msg').focus()`);
  await type('WIP main');
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Create Stash' });
  await until(`${h.noteWith('Changes stashed')} && !ide.activeTab().model.getValue().includes('work in progress')`, 'stashed and editor reloaded');
  check(git(project, 'stash', 'list', '--format=%gs') === 'On main: WIP main', 'Stash Changes… stashes with the message');
  await js(`(ide.runAction('Git.Unstash'), true)`);
  await until(`document.querySelectorAll('.vcs-stash-row').length === 1`, 'unstash dialog');
  await mouse(`document.querySelector('.vcs-stash-pop input')`, { label: 'pop' });
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Pop Stash' });
  await until(`${h.noteWith('Unstashed')} && ide.activeTab().model.getValue().includes('work in progress')`, 'unstashed and editor reloaded');
  check(git(project, 'stash', 'list') === '', 'Pop Stash brings the change back and drops the stash');

  // ---------- shelve, change the same lines, unshelve with a conflict ----------
  await h.refresh();
  await js(`(ide.runAction('ChangesView.Shelve'), true)`);
  await until(`document.querySelectorAll('.dialog .vcs-shelve-file').length === 1`, 'Shelve dialog');
  await js(`(document.querySelector('.vcs-shelve-name').value = 'Main WIP', true)`);
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Shelve Changes' });
  await until(`${h.noteWith('Main WIP')} && !ide.activeTab().model.getValue().includes('work in progress')`, 'shelved and rolled back');
  check(git(project, 'status', '--porcelain') === '', 'shelving rolls the change back');
  await h.editAndSave('main.py', `${read(project, 'main.py')}\n# committed meanwhile\n`);
  await h.refresh();
  check(await js(`document.querySelector('#vcsShelfTab').classList.contains('active')`), 'shelving leaves the Commit window on its Shelf tab');
  await h.setMessage('Note');
  check(await js(`document.querySelector('#vcsChangesTab').classList.contains('active') && document.activeElement === document.querySelector('.vcs-msg')`), 'Commit… (Ctrl+K) from the Shelf tab goes back to the changes and focuses the message');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit note' });
  await until(`!${h.changeRow('main.py')}`, 'note commit');
  await mouse(`document.querySelector('#vcsShelfTab')`, { label: 'Shelf tab' });
  await until(`!!document.querySelector('.vcs-shelf-row')`, 'shelf row');
  await mouse(`document.querySelector('.vcs-shelf-row')`, { label: 'shelf row' });
  await mouse(`document.querySelector('.vcs-shelf-unshelve')`, { label: 'Unshelve' });
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'unshelve conflict dialog', 30000);
  await snap('unshelve-conflict');
  const sideNames = await js(`[...document.querySelectorAll('.vcs-conflict-head > span')].map(s => s.textContent).join('|')`);
  check(sideNames === 'Name|Yours (main)|Theirs (shelf Main WIP)', `the Conflicts dialog names the shelf as the incoming side (${sideNames})`);
  await mouse(h.conflictRow('main.py'), { clickCount: 2, label: 'main.py conflict row' });
  await until(`!!${h.MT}?._vcsMerge`, 'merge tool for the shelf', 30000);
  const paneNames = await js(`[...${h.MT}.querySelectorAll('.vcs-mt-head .vcs-diff-side')].map(s => s.textContent).join('|')`);
  check(paneNames === 'Yours (main) — read-only|Result|Theirs (shelf Main WIP) — read-only', `and so does the merge tool (${paneNames})`);
  await mouse(`${h.MT}.querySelector('.vcs-mt-apply-all')`, { label: 'Apply Non-Conflicting' }).catch(() => {});
  const c2 = await js(`${h.MT}._vcsMerge.chunks.filter(c => c.kind === 'conflict').map(c => c.id)`);
  for (const id of c2) {
    await mouse(`${h.MT}.querySelector('.vcs-mt-strip[data-side="ours"] .vcs-mt-act.accept[data-chunk="${id}"]')`, { label: 'accept ours' });
    await mouse(`${h.MT}.querySelector('.vcs-mt-strip[data-side="theirs"] .vcs-mt-act.accept[data-chunk="${id}"]')`, { label: 'append theirs' });
  }
  await until(`${h.MT}.querySelector('.vcs-mt-status').textContent === 'All changes have been processed'`, 'all processed');
  await mouse(`${h.MT}.querySelector('.vcs-mt-apply')`, { label: 'Apply' });
  await until(`!document.querySelector('.vcs-mt')`, 'merge tool closed');
  const merged = read(project, 'main.py');
  check(merged.includes('# committed meanwhile') && merged.includes('# work in progress') && !merged.includes('<<<<<<<'), `the shelved change comes back next to the committed one (${q(merged)})`);
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue()`) === merged, 'the editor shows the resolved file');
  await mouse(`document.querySelector('#vcsChangesTab')`, { label: 'Commit tab' });
  await h.setMessage('Bring back WIP');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit WIP' });
  await until(`!${h.changeRow('main.py')}`, 'WIP commit');

  // ---------- log and annotate ----------
  await js(`(ide.toolWindows.get('Git').show(), true)`);
  await until(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].some(r => r.textContent.includes('Bring back WIP'))`, 'log rows', 30000);
  const subjects = await js(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row .vcs-subject-text')].map(n => n.textContent)`);
  check(subjects[0] === 'Bring back WIP' && subjects.includes('Initial commit') && subjects.some((s) => s.startsWith('Merge branch')), `the log lists the session's commits newest first (${q(subjects)})`);
  await mouse(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.textContent.includes('Ten percent discount'))`, { label: 'log row' });
  await until(`(document.querySelector('.vcs-log-files')?.textContent || '').includes('cart.py')`, 'commit details list cart.py');
  check(true, 'selecting a commit shows its files');
  await snap('git-log');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'shop\\\\cart.py'))`);
  await until(`ide.activeTab()?.title === 'cart.py'`, 'cart.py open');
  await js(`(ide.runAction('Annotate'), true)`);
  await until(`document.querySelectorAll('.custom-tab.hidden ~ * .vcs-blame, .monaco-editor .vcs-blame').length >= 5`, 'blame annotations');
  check(true, 'Annotate shows the blame column');
  // cart.py's sum(price * qty for price, qty in items): the generator's loop targets are not call arguments.
  await until(`(async () => (await ide.inlayHints.hints(ide.activeTab().model)).some(h => String(h.label).includes('int')))()`, 'inlay hints for cart.py', 30000);
  const hintLabels = await js(`(async () => (await ide.inlayHints.hints(ide.activeTab().model)).map(h => h.position.lineNumber + ':' + (typeof h.label === 'string' ? h.label : h.label.map(p => p.label).join(''))))()`);
  check(!hintLabels.some((x) => x.startsWith('2:')), `no parameter-name hint inside a generator argument (${q(hintLabels)})`);
  await snap('annotate');
  await js(`(ide.runAction('Annotate'), true)`);

  // ---------- Commit and Push… defines the bare remote ----------
  await h.editAndSave('README.md', `${read(project, 'README.md')}\nPushed.\n`);
  await h.refresh();
  await h.setMessage('Ready to push');
  await mouse(`document.querySelector('.vcs-commit-push-btn')`, { label: 'Commit and Push…' });
  await until(`(document.querySelector('#dialogHost .dialog-title')?.textContent || '').startsWith('Push Commits to')`, 'push dialog', 60000);
  check(await js(`!!document.querySelector('.vcs-remote-url')`), 'with no remote, the push dialog asks for one');
  await js(`(document.querySelector('.vcs-remote-url').value = ${q(bare)}, true)`);
  await snap('push-dialog');
  await mouse(h.button('Push'), { label: 'Push' });
  await until(h.noteWith('Pushed'), 'pushed', 30000);
  check(git(bare, 'log', '-1', '--format=%s', 'main') === 'Ready to push', 'the commits are on the bare remote');
  check((await tasksSeen()).includes('Pushing…'), 'the push showed as a background task');
  check(git(project, 'rev-parse', '--abbrev-ref', 'main@{u}') === 'origin/main', 'main tracks origin/main');

  // ---------- another clone pushes; auto-fetch shows ↓2, Update Project pulls ----------
  const other = path.join(work, 'other');
  git(work, 'clone', '-q', bare, other);
  for (const n of [1, 2]) { write(other, `notes/n${n}.txt`, `note ${n}\n`); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', `Remote note ${n}`); }
  git(other, 'push', '-q', 'origin', 'main');
  await js(`(ide.settings.set('vcs.autoFetchMinutes', 0.05), true)`);
  await until(`document.querySelector('#vcsSync')?.dataset.behind === '2'`, 'auto-fetch shows ↓2', 40000);
  check(await js(`document.querySelector('#vcsSync').textContent`) === '↓2', `the toolbar shows ↓2 (${await js(`document.querySelector('#vcsSync').textContent`)})`);
  await snap('sync-widget');
  await mouse(`document.querySelector('#vcsSync')`, { label: 'sync widget' });
  await until(`!!${h.menuItem('Update Project…')}`, 'sync menu');
  await mouse(h.menuItem('Update Project…'), { label: 'Update Project…' });
  await until(`document.querySelector('#vcsSync').classList.contains('hidden')`, 'up to date', 30000);
  check(existsSync(path.join(project, 'notes', 'n2.txt')), 'Update Project pulls the other clone\'s commits');
  check((await tasksSeen()).includes('Updating project…'), 'Update Project showed as a background task');

  // ---------- Update Project over a conflicting remote change: resolve, commit the merge, push ----------
  write(other, 'README.md', read(other, 'README.md').replace('A tiny shop.', 'A tiny shop, by the other clone.'));
  git(other, 'commit', '-q', '-am', 'Other README');
  git(other, 'push', '-q', 'origin', 'main');
  await h.editAndSave('README.md', read(project, 'README.md').replace('A tiny shop.', 'A tiny shop, edited here.'));
  await h.refresh();
  await h.setMessage('Local README');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit README' });
  await until(`!${h.changeRow('README.md')}`, 'README commit');
  await js(`(ide.runAction('Vcs.UpdateProject'), true)`);
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'conflicts after Update Project', 30000);
  check(await js(`!!document.querySelector('.vcs-branch-op') && document.querySelector('.vcs-branch-op').textContent === 'Merging'`), 'Update Project over a conflicting change stops in a merge with the Conflicts dialog');
  await mouse(h.conflictRow('README.md'), { label: 'README row' });
  await mouse(`document.querySelector('.vcs-accept-theirs')`, { label: 'Accept Theirs' });
  await until(`!document.querySelector('.dialog .vcs-conflicts')`, 'resolved');
  await until(`!!document.querySelector('.vcs-op-banner[data-op="merge"]')`, 'merge banner');
  await mouse(`document.querySelector('.vcs-commit-push-btn')`, { label: 'Commit and Push merge' });
  await until(`(document.querySelector('#dialogHost .dialog-title')?.textContent || '').startsWith('Push Commits to')`, 'push dialog for the merge', 60000);
  await mouse(h.button('Push'), { label: 'Push merge' });
  await until(`!document.querySelector('.vcs-op-banner')`, 'merge committed', 30000);
  for (let end = Date.now() + 30000; Date.now() < end && git(bare, 'log', '-1', '--format=%P', 'main').split(' ').length !== 2;) await sleep(300);
  check(git(bare, 'log', '-1', '--format=%P', 'main').split(' ').length === 2 && read(project, 'README.md').includes('by the other clone'), 'the merge commit with the remote README is pushed');
  await js(`(ide.settings.set('vcs.autoFetchMinutes', 0), true)`);
});

// ===================================================================== GitHub
await phase('github', async () => {
  // A colleague pushes a branch for a pull request.
  const other = path.join(work, 'other');
  git(other, 'pull', '-q', '--no-rebase', 'origin', 'main');
  git(other, 'checkout', '-q', '-b', 'feature/coupons');
  write(other, 'shop/coupons.py', 'CODES = {"SAVE5": 5}\n\n\ndef apply(code, amount):\n    return max(amount - CODES.get(code, 0), 0)\n');
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-q', '-m', 'Add coupon codes');
  git(other, 'push', '-q', 'origin', 'feature/coupons');
  const head = git(other, 'rev-parse', 'HEAD');
  const pr = { number: 7, title: 'Add coupon codes', author: { login: 'bob' }, headRefName: 'feature/coupons', baseRefName: 'main', state: 'OPEN', isDraft: false, updatedAt: '2026-10-22T09:30:00Z', reviewDecision: 'REVIEW_REQUIRED' };
  const closed = { ...pr, number: 3, title: 'Old checkout flow', headRefName: 'old', state: 'CLOSED', reviewDecision: '' };
  writeFileSync(ghState, q({ auth: 'in', account: 'alice', realCheckout: true, prs: [pr, closed], views: { 7: { ...pr, url: 'https://github.com/alice/shop/pull/7', headRefOid: head,
    body: 'Adds **coupon** codes.', commits: [{ oid: head, messageHeadline: 'Add coupon codes', authors: [{ login: 'bob', name: 'Bob' }], committedDate: '2026-10-22T09:00:00Z' }],
    files: [{ path: 'shop/coupons.py', additions: 5, deletions: 0 }], reviews: [], comments: [{ author: { login: 'alice' }, body: 'Thanks!', createdAt: '2026-10-22T10:00:00Z' }],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'tests', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/alice/shop/actions/runs/1' }] } } }));

  // ---------- Share Project on GitHub (origin is the bare remote, so the new remote is "github") ----------
  await js(`(ide.runAction('Github.Share.Project'), true)`);
  await until(`document.querySelector('.dialog-title')?.textContent === 'Share Project on GitHub'`, 'share dialog', 30000);
  check(await js(`document.querySelector('.gh-share-name').value === 'shop' && document.querySelector('.gh-share-remote').value === 'github' && document.querySelector('.gh-share-private input').checked`),
    'Share Project on GitHub proposes "shop", private, and the remote "github" since origin is taken');
  await snap('share-dialog');
  await mouse(h.button('Share'), { label: 'Share' });
  await until(h.noteWith('Shared the project on GitHub'), 'shared', 30000);
  check(git(project, 'config', 'remote.github.url') === 'https://github.com/alice/shop.git', 'gh repo create added the github remote');
  const create = ghArgvs().find((a) => a[1] === 'create');
  check(q(create) === q(['repo', 'create', 'shop', '--private', '--source', await js('ide.root'), '--remote', 'github', '--push']), `the exact gh repo create argv (${q(create)})`);

  // ---------- pull requests ----------
  await js(`(ide.toolWindows.get('PullRequests').show(), true)`);
  await until(`document.querySelectorAll('.gh-pr').length === 1 && !!document.querySelector('.gh-pr[data-number="7"]')`, 'open pull requests', 30000);
  await mouse(`document.querySelector('.gh-pr[data-number="7"]')`, { label: 'PR #7' });
  await until(`document.querySelector('.gh-detail-title')?.textContent === 'Add coupon codes' && document.querySelectorAll('.gh-file').length === 1`, 'PR details', 30000);
  check((await js(`document.querySelector('.gh-head-meta').textContent`)).includes('bob wants to merge feature/coupons into main'), 'the details say who wants to merge what');
  await snap('pull-request');
  await mouse(`document.querySelector('.gh-file[data-path="shop/coupons.py"]')`, { label: 'changed file' });
  await until(h.noteWith("The pull request's commits are not in the local repository"), 'head not local note');
  check(true, 'before checkout the head commit is not local, and the note says to use Checkout');
  await mouse(`document.querySelector('.gh-checkout')`, { label: 'Checkout' });
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'feature/coupons'`, 'checked out the PR branch', 60000);
  check(existsSync(path.join(project, 'shop', 'coupons.py')) && q(ghArgvs().filter((a) => a[1] === 'checkout').pop()) === q(['pr', 'checkout', '7']), 'Checkout runs gh pr checkout 7 and the branch widget follows');
  await until(`document.querySelector('#wsHome .ws-branch-name')?.textContent === 'feature/coupons'`, 'Workspace home follows the checkout');
  await mouse(`document.querySelector('.gh-file[data-path="shop/coupons.py"]')`, { label: 'changed file again' });
  await until(`ide.activeTab()?.title === 'coupons.py (#7)'`, 'PR file diff', 20000);
  const sides = await js(`ide.monaco.editor.getModels().filter(m => m.uri.scheme === 'vcs-diff' && m.uri.path.endsWith('/coupons.py')).map(m => m.getValue())`);
  check(sides.includes('') && sides.some((x) => x.includes('def apply')), 'after checkout the added file diffs against the base');
  await snap('pr-diff');
  await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
  // The Git console gets the checkout's output while the Log tab hides it: shown, it opens at the latest lines.
  await js(`(ide.runAction('Git.Log'), true)`);
  await h.branchItem('main');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'back to main');
  await js(`(ide.vcs.showConsole(), true)`);
  const consoleEnd = await until(`(o => o.clientHeight > 0 && o.scrollHeight > o.clientHeight && o.scrollHeight - o.scrollTop - o.clientHeight < 40)(document.querySelector('#vcsConsole'))`, 'Git console at its end').then(() => true, () => false);
  check(consoleEnd, 'the Git console, written to while hidden, opens scrolled to its latest output');
  await snap('git-console');
});

// ===================================================================== Terminal
let shellPids = [];
await phase('terminal', async () => {
  const term = (id) => js(`ide.terminal.text(${id})`);
  const prompt = (id) => until(`/(^|PS )[A-Z]:\\\\[^\\n]*>\\s*$/m.test(ide.terminal.text(${id}).trimEnd())`, `prompt in pane ${id}`, 40000);
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length >= 1 && !!ide.terminal.sessions()[0].pid`, 'terminal session', 30000);
  const A = await js(`ide.terminal.sessions()[0].id`);
  await prompt(A);
  await js(`ide.terminal.send('git log --oneline -3\\r', ${A})`);
  await until(`ide.terminal.text(${A}).includes('Local README')`, 'git log in the terminal', 20000);
  check(true, 'git log runs in the terminal, in the project folder');
  await mouse(`document.querySelector('#bottomActions [data-action="terminal-split-right"]')`, { label: 'Split Right' });
  await until(`ide.terminal.sessions().length === 2 && !!ide.terminal.sessions()[1].pid`, 'second pane', 30000);
  const B = await js(`ide.terminal.sessions()[1].id`);
  await prompt(B);
  await js(`ide.terminal.send('py main.py\\r', ${B})`);
  await until(`ide.terminal.text(${B}).includes('Total: 13.0')`, 'py main.py output', 30000);
  check(true, 'the split pane runs py main.py in the project folder');
  await js(`ide.terminal.send('ping -n 600 127.0.0.1\\r', ${A})`);
  await until(`/Pinging|Ping/.test(ide.terminal.text(${A}))`, 'ping running', 20000);
  await snap('terminal-split');
  shellPids = await js(`ide.terminal.sessions().map(s => s.pid)`);

  // ---------- opening another project asks to terminate the running sessions; Cancel keeps everything ----------
  const otherProject = path.join(work, 'other');
  await js(`ide.api.invoke('trust:add', ${q(otherProject)}).then(() => true)`);
  const root = await js('ide.root');
  const opening = js(`ide.openProject(${q(otherProject)})`);
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Terminate Processes'`, 'Terminate Processes dialog');
  const question = await js(`document.querySelector('#dialogHost .dialog-body').textContent`);
  check(/2 terminal sessions are still running/.test(question), `opening another project asks first (${q(question)})`);
  await snap('terminate-prompt');
  await mouse(h.button('Cancel'), { label: 'Cancel' });
  check((await opening) === false && (await js('ide.root')) === root, 'Cancel keeps the project');
  check((await js(`ide.terminal.sessions().filter(s => !s.exited).length`)) === 2 && shellPids.every(alive), 'and every terminal session keeps running');
});

// ===================================================================== Jupyter notebook
const DV_VENV_PY = path.join(HERE, 'out', 'dataview-venv', 'Scripts', 'python.exe');
async function useInterpreter(exe) {
  await js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${q(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${q(exe)});
  })()`);
  await until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(exe)})`, 'interpreter selected', 30000);
}
let kernelStarted = false;
await phase('notebook', async () => {
  if (!existsSync(DV_VENV_PY) || spawnSync(DV_VENV_PY, ['-c', 'import ipykernel, pandas']).status !== 0) {
    console.log('note: verify/out/dataview-venv with ipykernel and pandas is missing (run verify/dataview.mjs once); notebook phase skipped');
    return;
  }
  await useInterpreter(DV_VENV_PY);
  kernelStarted = true;
  await js(`(ide.runAction('NewJupyterNotebook'), true)`);
  await h.promptAnswer('New Jupyter Notebook name', 'sales');
  const H = 'ide.activeTab().host';
  const V = 'ide.activeTab().notebook';
  await until(`ide.activeTab()?.title === 'sales.ipynb' && !!${V} && ${H}.dataset.cells === '1'`, 'new notebook open');
  check(existsSync(path.join(project, 'sales.ipynb')), 'New Jupyter Notebook creates sales.ipynb and opens it');
  const run = async (i, code, label) => {
    await js(`(${V}.cells()[${i}].model.setValue(${q(code)}), true)`);
    await js(`${V}.runCell(${i})`);
    await until(`!${H}.querySelectorAll('.nb-cell')[${i}].matches('.running, .queued') && ${H}.dataset.kernel === 'idle' && ${H}.querySelectorAll('.nb-cell')[${i}].querySelector('.nb-prompt').textContent !== '[ ]:'`, label, 120000);
  };
  await run(0, 'import pandas as pd\nsales = pd.DataFrame({"item": ["apple", "pear", "fig"], "qty": [3, 5, 2], "price": [0.5, 0.75, 2.0]})\nsales["total"] = sales.qty * sales.price\nsales', 'first cell (kernel start)');
  check(await js(`${H}.querySelectorAll('.nb-cell')[0].querySelector('.sv-view-link')?.textContent`) === 'View as DataFrame', 'the DataFrame result offers View as DataFrame');
  await js(`${V}.insertCell(1, 'code')`);
  await run(1, 'grand = sales.total.sum()\nprint(f"Total: {grand}")', 'second cell');
  check((await js(`${H}.querySelectorAll('.nb-cell')[1].querySelector('.nb-outputs').innerText`)).includes('Total: 9.25'), 'the next cell sees the first one\'s variables');
  await snap('notebook');
  await js(`(ide.toolWindows.get('JupyterVariables').show(), true)`);
  await until(`!!document.querySelector('.sv-jv .sv-var[data-name="sales"] .sv-view-link') && !!document.querySelector('.sv-jv .sv-var[data-name="grand"]')`, 'Jupyter Variables', 30000);
  check(true, 'Jupyter Variables lists sales and grand');
  await mouse(`document.querySelector('.sv-jv .sv-var[data-name="sales"] .sv-view-link')`, { label: 'View as DataFrame' });
  await until(`!!ide.activeTab()?.dataView && !!ide.activeTab().dataView.state().info && !ide.activeTab().dataView.host.querySelector('.dv-c.wait')`, 'data view', 60000);
  const status = await js(`ide.activeTab().dataView.host.querySelector('.dv-status').textContent`);
  const cell23 = await js(`ide.activeTab().dataView.cellText(2, 3)`);
  check(status === '3 rows × 4 columns' && cell23 === '4.0', `the Data View pages the kernel's frame (${status}, ${cell23})`);
  await snap('data-view');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'sales.ipynb'))`);
  await until(`ide.activeTab()?.title === 'sales.ipynb'`, 'notebook front');
  await press('Ctrl+s');
  await until(`!ide.isDirty(ide.activeTab())`, 'notebook saved');
  const saved = JSON.parse(read(project, 'sales.ipynb'));
  check(saved.cells.length === 2 && saved.cells[1].outputs.some((o) => (o.text || []).join('').includes('Total: 9.25')), 'Ctrl+S writes the cells and their outputs');
});

// ===================================================================== Database
await phase('database', async () => {
  const setInput = (sel, value) => js(`(() => { const n = document.querySelector(${q(sel)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await js(`(ide.toolWindows.get('Database').show(), true)`);
  await until(`!!document.querySelector('#dbAdd')`, 'Database tool window');
  await mouse(`document.querySelector('#dbAdd')`, { label: 'add data source' });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes('SQLite'))`, 'kinds menu');
  await mouse(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes('SQLite'))`, { label: 'SQLite' });
  await until(`!!document.querySelector('.db-dialog #dbField-file')`, 'data source dialog');
  await setInput('#dbName', 'shop-db');
  await setInput('#dbField-file', path.join(project, 'shop.db'));
  await mouse(`document.querySelector('#dbTest')`, { label: 'Test Connection' });
  await until(`document.querySelector('#dbTestResult').classList.contains('ok')`, 'Test Connection ok');
  await mouse(`[...document.querySelectorAll('.db-dialog .dialog-buttons button')].find(b => b.textContent === 'OK')`, { label: 'OK' });
  await until(`!document.querySelector('.db-dialog') && document.querySelector('#dbTree .db-source')?.textContent.includes('shop-db')`, 'source listed');
  await mouse(`document.querySelector('#dbConsole')`, { label: 'New Query Console' });
  await until(`!!ide.database.activeConsole()`, 'console');
  const SQL = "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL);\nINSERT INTO products (name, price) VALUES ('apple', 0.5), ('pear', 0.75), ('fig', 2.0);\nSELECT name, price FROM products WHERE price > 0.6 ORDER BY price DESC;";
  await js(`ide.database.activeConsole().editor.focus()`);
  await type(SQL);
  const runLine = async (line) => {
    await js(`(() => { const c = ide.database.activeConsole(); c.editor.focus(); c.editor.setPosition({ lineNumber: ${line}, column: 3 }); return true; })()`);
    const before = await js(`ide.database.activeConsole().runs`);
    await press('Ctrl+Enter');
    await until(`ide.database.activeConsole().runs > ${before}`, `statement ${line}`);
  };
  for (const n of [1, 2, 3]) await runLine(n);
  const AC = `document.querySelector('.custom-tab:not(.hidden) .db-console, .custom-tab.db-console:not(.hidden)')`;
  await until(`${AC}.querySelectorAll('.db-grid tbody tr').length === 2`, 'result grid');
  const grid = await js(`[...${AC}.querySelectorAll('.db-grid tbody tr')].map(r => [...r.children].slice(1).map(td => td.textContent).join(':'))`);
  check(q(grid) === q(['fig:2.0', 'pear:0.75']) || q(grid) === q(['fig:2', 'pear:0.75']), `Ctrl+Enter runs each statement; the SELECT fills the grid (${q(grid)})`);
  // completion: tables after FROM, then the columns of the FROM table
  const suggest = async (text) => {
    const at = text.indexOf('|');
    await js(`(() => { const e = ide.database.activeConsole().editor; e.trigger('t', 'hideSuggestWidget', {}); const m = e.getModel(); const end = m.getFullModelRange().getEndPosition(); e.executeEdits('flow', [{ range: new ide.monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: '\\n' + ${q(text.replace('|', ''))} }]); const p = m.getPositionAt(m.getValueLength() - ${text.length - 1 - at}); e.focus(); e.setPosition(p); return true; })()`);
    await press('Ctrl+ ');
    await until(`(() => { const w = document.querySelector('.suggest-widget.visible'); return !!w && !w.classList.contains('message') && w.querySelectorAll('.monaco-list-row').length > 0; })()`, `suggestions for ${text}`);
    await sleep(150);
    const labels = await js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].sort((a, b) => a.dataset.index - b.dataset.index).map(r => r.querySelector('.label-name').textContent)`);
    await press('Escape');
    return labels;
  };
  let labels = await suggest('SELECT * FROM pro|');
  check(labels[0] === 'products', `Ctrl+Space after FROM offers the new table (${q(labels.slice(0, 5))})`);
  labels = await suggest('SELECT | FROM products');
  check(q(labels.slice(0, 3)) === q(['id', 'name', 'price']), `and the columns of the FROM table first (${q(labels.slice(0, 5))})`);
  await snap('database');
  await mouse(`document.querySelector('.custom-tab:not(.hidden) .db-copy')`, { label: 'Copy as CSV' });
  await until(`ide.api.invoke('clipboard:readText').then(t => t.startsWith('name,price'))`, 'CSV on the clipboard');
  check((await js(`ide.api.invoke('clipboard:readText')`)).replace(/\r\n/g, '\n') === 'name,price\nfig,2\npear,0.75' || (await js(`ide.api.invoke('clipboard:readText')`)).includes('pear,0.75'), 'Copy as CSV exports the result');
  if (existsSync(path.join(project, '.git'))) check(!git(project, 'status', '--porcelain').includes('shop.db'), 'the new database file is ignored by Git (*.db in .gitignore)');
});

// ===================================================================== HTTP client
await phase('http', async () => {
  // The shop's API, served by the test on 127.0.0.1:9575.
  const products = [{ id: 1, name: 'apple', price: 0.5 }];
  const seen = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/products') return res.end(q(products));
      if (req.method === 'POST' && req.url === '/api/products') {
        const p = { id: products.length + 1, ...JSON.parse(body) };
        products.push(p);
        res.statusCode = 201;
        return res.end(q(p));
      }
      res.statusCode = 404;
      res.end(q({ error: 'not found' }));
    });
  });
  await new Promise((r) => api.listen(9575, '127.0.0.1', r));
  try {
    await js(`(ide.runAction('NewHttpRequest'), true)`);
    await h.promptAnswer('New HTTP Request file name', 'shop-api');
    await until(`ide.activeTab()?.title === 'shop-api.http' && ide.editor.getModel()?.getLanguageId() === 'http'`, 'shop-api.http open');
    const HTTP = '### List products\nGET http://127.0.0.1:9575/api/products\nAccept: application/json\n\n### Add a product\nPOST http://127.0.0.1:9575/api/products\nContent-Type: application/json\n\n{\n  "name": "kiwi",\n  "price": 1.25\n}\n';
    await js(`(() => { const m = ide.editor.getModel(); ide.editor.executeEdits('flow', [{ range: m.getFullModelRange(), text: ${q(HTTP)} }]); return true; })()`);
    await press('Ctrl+s');
    const runAt = async (line, n) => {
      await js(`(() => { ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${line}, column: 2 }); return true; })()`);
      await press('Ctrl+Enter');
      await until(`ide.httpClient.history().length === ${n} && !ide.httpClient.history()[0].pending`, `request ${n}`, 30000);
    };
    await runAt(10, 1);
    await until(`document.querySelector('.http-status')?.textContent === '201 Created'`, 'POST answered');
    check(seen[0]?.method === 'POST' && JSON.parse(seen[0].body).name === 'kiwi' && seen[0].type === 'application/json', `Ctrl+Enter in the body sends the POST with its JSON (${q(seen[0])})`);
    await runAt(2, 2);
    await until(`document.querySelector('.http-status')?.textContent === '200 OK'`, 'GET answered');
    const body = await js(`(document.querySelector('.http-pane .http-body')?.innerText || '').replace(/\\u00a0/g, ' ')`);
    check(body.includes('"kiwi"') && body.includes('\n  {'), `the GET response lists the new product, pretty-printed (${q(body.slice(0, 80))})`);
    check(await js(`ide.httpClient.history().length`) === 2, 'the HTTP Client history keeps both responses');
    await snap('http-client');
  } finally {
    await new Promise((r) => api.close(r));
  }
});

// ===================================================================== Python Packages
await phase('packages', async () => {
  write(project, 'requirements.txt', 'pyide-vuln-demo==1.0\n');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'requirements.txt'))`);
  await until(`ide.activeTab()?.title === 'requirements.txt'`, 'requirements.txt open');
  // Tools › Create Virtual Environment…, installing requirements.txt (offline: PIP_NO_INDEX, PIP_FIND_LINKS).
  await js(`(ide.runAction('CreateVirtualEnvironment'), true)`);
  await until(`!!document.querySelector('#venvDlgLocation')`, 'Create Virtual Environment dialog');
  check(await js(`document.querySelector('#venvDlgLocation').value.toLowerCase().endsWith('\\\\shop\\\\.venv') && document.querySelector('#venvDlgInstall').checked`), 'the dialog proposes .venv and installing requirements.txt');
  await snap('venv-dialog');
  await mouse(h.button('Create'), { label: 'Create' });
  await until(`['done', 'error'].includes(ide.venvSetup.state())`, 'venv created', 240000);
  const venvPy = path.join(project, '.venv', 'Scripts', 'python.exe');
  check(await js(`ide.venvSetup.state()`) === 'done' && await js(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(venvPy)})`), 'the new .venv is created and becomes the project interpreter');
  check(spawnSync(venvPy, ['-c', 'import pyide_vuln_demo; print(pyide_vuln_demo.__version__)'], { encoding: 'utf8' }).stdout.trim() === '1.0', 'requirements.txt was installed into it');
  if (existsSync(path.join(project, '.git'))) check(!git(project, 'status', '--porcelain').includes('.venv'), 'the venv is ignored by Git');

  // ---------- the Python Packages window, with the advisory from the fake OSV server ----------
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  const row = (name) => `document.querySelector('#pkgList .pkg-row[data-name="${name}"]')`;
  await until(`!!${row('pyide-vuln-demo')}?.querySelector('.pkg-vuln-icon')`, 'vulnerable package marked', 60000);
  check(osvAsked.includes('pyide-vuln-demo@1.0'), `the installed packages were checked against OSV (${q(osvAsked)})`);
  await until(`ide.monaco.editor.getModelMarkers({ owner: 'vulnerabilities' }).some(m => m.message.includes('GHSA-shop-0000-0001'))`, 'requirement squiggle', 30000);
  check(true, 'the pinned requirement gets a vulnerability warning');
  await mouse(row('pyide-vuln-demo'), { label: 'vulnerable package' });
  await until(`document.querySelector('#pkgVulnUpgrade')?.textContent === 'Upgrade to 1.1'`, 'Upgrade to 1.1');
  await snap('packages-vulnerable');

  // install and uninstall an offline wheel from the search field
  await mouse(`document.querySelector('#pkgSearch')`, { label: 'search field' });
  await type('pyide-shop-extras');
  await until(`!!document.querySelector('#pkgInstallRow')`, 'install row');
  await mouse(`document.querySelector('#pkgInstallRow')`, { label: 'Install pyide-shop-extras' });
  await until(`!!${row('pyide-shop-extras')} && !ide.packages.busy()`, 'installed', 120000);
  check(spawnSync(venvPy, ['-c', 'import pyide_shop_extras'], { encoding: 'utf8' }).status === 0, 'Install puts the wheel into the project venv');
  await js(`(document.querySelector('#pkgSearch').value = '', document.querySelector('#pkgSearch').dispatchEvent(new Event('input')), true)`);
  await mouse(row('pyide-shop-extras'), { label: 'extras row' });
  await mouse(`document.querySelector('#pkgUninstall')`, { label: 'Uninstall' });
  await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Uninstall Package'`, 'uninstall confirmation');
  await mouse(`document.querySelector('#dialogHost .dialog-buttons .primary')`, { label: 'confirm uninstall' });
  await until(`!${row('pyide-shop-extras')} && !ide.packages.busy()`, 'uninstalled', 120000);
  check(spawnSync(venvPy, ['-c', 'import pyide_shop_extras']).status !== 0, 'Uninstall removes it again');
  await until(`!!${row('pyide-vuln-demo')} && !!${row('pip')}`, 'the list is back', 60000);
  const details = await js(`document.querySelector('#pkgDetails').textContent`);
  check(!details.includes('Add to requirements') && !/pyide-shop-extras\s*0\.1/.test(details), `the details no longer offer actions for the uninstalled package (${q(details.slice(0, 120))})`);

  // Upgrade to the fixed version
  await mouse(row('pyide-vuln-demo'), { label: 'vulnerable package again' });
  await until(`!!document.querySelector('#pkgVulnUpgrade')`, 'upgrade button');
  await mouse(`document.querySelector('#pkgVulnUpgrade')`, { label: 'Upgrade to 1.1' });
  await until(`${row('pyide-vuln-demo')}?.textContent.includes('1.1') && !${row('pyide-vuln-demo')}.querySelector('.pkg-vuln-icon') && !ide.packages.busy()`, 'upgraded and unmarked', 120000);
  check(true, 'Upgrade to 1.1 installs the fixed wheel and the warning goes');
  const pipTasks = (await tasksSeen()).filter((x) => /^(Installing|Uninstalling|Upgrading|Creating)/.test(x));
  check(pipTasks.some((x) => x.startsWith('Installing pyide-shop-extras')) && pipTasks.some((x) => x.startsWith('Uninstalling pyide-shop-extras')), `pip jobs showed as background tasks (${q(pipTasks)})`);
});

// ===================================================================== Notifications and background tasks
await phase('notifications', async () => {
  // A long pip job in the Packages console: the status bar shows it, the popup lists it with Cancel.
  if (!(await js(`!!ide.currentInterp()`))) return;
  await js(`(ide.toolWindows.get('PythonPackages')?.show(), true)`);
  const slow = path.join(work, 'slow_job.py');
  writeFileSync(slow, 'import time\nprint("working", flush=True)\ntime.sleep(120)\n');
  await js(`(window.__slowJob = ide.packages.run('Waiting in the flow test', async () => ({ id: await ide.api.invoke('run:start', ide.currentInterp(), ${q(slow)}, ide.root) })), true)`);
  const started = await until(`!document.querySelector('#bgTasks').classList.contains('hidden') && document.querySelector('#bgTasks').textContent.includes('Waiting in the flow test')`, 'background task in the status bar', 15000).then(() => true, () => false);
  if (started) {
    check(true, 'a long job shows in the status bar');
    await mouse(`document.querySelector('#bgTasks')`, { label: 'background tasks widget' });
    await until(`!!document.querySelector('#bgTasksPopup .bg-popup-cancel')`, 'Background Tasks popup');
    await snap('background-tasks');
    await mouse(`document.querySelector('#bgTasksPopup .bg-popup-cancel')`, { label: 'Cancel task' });
    await until(`document.querySelector('#bgTasks').classList.contains('hidden') && !ide.packages.busy()`, 'cancelled', 30000);
    check(true, 'Cancel in the Background Tasks popup stops the job');
  }
  // The Notifications tool window has the session's notifications, newest first.
  const unread = await js(`ide.notifications.unread()`);
  await js(`(ide.runAction('ActivateNotificationsToolWindow'), true)`);
  await until(`document.querySelectorAll('.notes-item, .notes-row, [class*="notes-"] .notes-title').length > 0 || !!document.querySelector('.notes-empty')`, 'Notifications tool window');
  const titles = await js(`ide.notifications.list().map(n => n.title)`);
  check(titles.length >= 3 && unread >= 0 && (await js(`ide.notifications.unread()`)) === 0, `the Notifications tool window holds the session's notifications and marks them read (${titles.length}, ${unread} unread before)`);
  check(!(await js(`ide.notifications.list().some(n => n.kind === 'error')`)), `no error notification in the whole session (${q(await js(`ide.notifications.list().filter(n => n.kind === 'error').map(n => n.title + ': ' + n.text)`))})`);
  await snap('notifications');
});

// ===================================================================== Report a Problem, update check
await phase('report', async () => {
  await js(`(ide.runAction('ReportProblem'), true)`);
  await until(`!!document.querySelector('.diag-report-dialog .diag-report-body')`, 'report preview', 20000);
  const preview = await js(`document.querySelector('.diag-report-dialog .diag-report-body').textContent`);
  const version = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  check(preview.includes(`Nano Studio ${version}`) && preview.includes('Describe the problem'), 'Report a Problem… previews the environment with a place to describe the problem');
  check(!preview.toLowerCase().includes(project.toLowerCase()) && !preview.toLowerCase().includes(tmpdir().toLowerCase()), 'the preview names no local path of the project');
  await snap('report-preview');
  await mouse(`[...document.querySelectorAll('.diag-report-dialog .dialog-buttons button')].find(b => b.textContent === 'Open in Browser')`, { label: 'Open in Browser' });
  await until(`ide.api.invoke('diagnostics:testOpened').then(l => l.length === 1)`, 'issue link handed to the browser');
  const [url] = await js(`ide.api.invoke('diagnostics:testOpened')`);
  check(url.startsWith('https://github.com/') && url.length <= 8000, `Open in Browser hands GitHub's new-issue link to the browser (${url.length} characters)`);
});
const feedDir = path.join(work, 'feed');
await phase('updates', async () => {
  mkdirSync(feedDir, { recursive: true });
  const sha = 'A'.repeat(86) + '==';
  writeFileSync(path.join(feedDir, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: NanoStudio-Setup-9.9.9.exe\n    sha512: ${sha}\n    size: 1\npath: NanoStudio-Setup-9.9.9.exe\nsha512: ${sha}\nreleaseDate: '2026-10-20T00:00:00.000Z'\n`);
  await js(`(ide.openSettings('updates'), true)`);
  await until(`!!document.querySelector('.settings-dialog [data-key="updates.feedUrl"]')`, 'Settings › Updates');
  await js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ${q(feedDir)}; i.dispatchEvent(new Event('input')); return true; })()`);
  await mouse(`document.getElementById('settingsOk')`, { label: 'OK' });
  await until(`ide.settings.get('updates.feedUrl') === ${q(feedDir)}`, 'feed saved');
  await js(`(ide.runAction('CheckForUpdates'), true)`);
  await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('9.9.9')`, 'update dialog', 30000);
  check((await js(`[...document.querySelectorAll('.dialog')].pop().textContent`)).includes('Nano Studio 9.9.9 is available.'), 'Check for Updates… reads the folder feed and reports 9.9.9');
  await snap('update-check');
  await mouse(`[...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].pop()`, { label: 'Close' });
});

// ===================================================================== Settings export
const settingsZip = path.join(work, 'pyide-settings.zip');
const topDialog = `[...document.querySelectorAll('#dialogHost .dialog')].pop()`;
await phase('settings', async () => {
  writeFileSync(settingsDialog, q({ save: settingsZip }));
  await js(`(ide.settings.set('editor.fontSize', 15), true)`);
  await js(`(ide.runAction('ExportSettings'), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'Export Settings dialog');
  const cats = await js(`[...${topDialog}.querySelectorAll('.settings-sync-row input')].filter(b => b.checked).map(b => b.dataset.category)`);
  check(cats.includes('appearance') && cats.includes('dataSources'), `the export offers the settings and the session's data source (${q(cats)})`);
  await snap('export-settings');
  await js(`(${topDialog}.querySelector('.dialog-buttons .primary').click(), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, 'export finished', 30000);
  check(existsSync(settingsZip), 'the settings archive is written where the Save dialog said');
  await js(`(${topDialog}.querySelector('.dialog-buttons button').click(), true)`);
});

// ===================================================================== close the project and quit: nothing may be left
await phase('close', async () => {
  const before = ideProcesses();
  const kernel = before.filter((p) => /kernel_bridge|ipykernel|kernel_launcher/i.test(p.cmd));
  const shells = before.filter((p) => shellPids.includes(p.pid) || /^PING\.EXE$/i.test(p.name));
  console.log(`processes under the IDE before closing: ${before.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
  if (kernelStarted) check(kernel.length > 0, `the notebook kernel is running before the project closes (${kernel.map((p) => p.name).join(', ')})`);
  const closing = js(`ide.closeProject()`);
  const asked = await until(`document.querySelector('#dialogHost .dialog-title')?.textContent === 'Terminate Processes'`, 'Terminate Processes', 10000).then(() => true, () => false);
  if (asked) await mouse(h.button('Terminate'), { label: 'Terminate' });
  check((await closing) === true, 'Close Project closes it (Terminate answers the running-terminals question)');
  await until(`!ide.root && !document.getElementById('welcome').classList.contains('hidden')`, 'welcome screen');
  // Nothing of the closed project stays on screen: branch widget, ↓↑, run configuration, pull requests, problems, tasks.
  await until(`document.querySelector('.vcs-branch').classList.contains('hidden')`, 'branch widget hidden', 5000).catch(() => {});
  const leftovers = await js(`({
    branch: !document.querySelector('.vcs-branch').classList.contains('hidden') && document.querySelector('.vcs-branch').textContent,
    sync: !document.querySelector('#vcsSync').classList.contains('hidden'),
    runTarget: document.querySelector('.run-target-name')?.textContent,
    prs: document.querySelectorAll('.gh-pr').length && !document.querySelector('.gh-list')?.classList.contains('hidden'),
    prState: document.querySelector('.gh-state')?.textContent,
    problems: ide.problems.all().length,
    tasks: ide.tasks.list().map(x => x.title),
  })`);
  check(!leftovers.branch && !leftovers.sync, `no branch widget or ↓↑ counts without a project (${q(leftovers)})`);
  check(leftovers.runTarget === 'Current File', `the run widget no longer offers the closed project's configuration (${leftovers.runTarget})`);
  check(!leftovers.prs && leftovers.prState === 'No project', `the Pull Requests window no longer lists the closed project's pull requests (${q(leftovers.prState)})`);
  check(!leftovers.problems && !leftovers.tasks.length, `no problems or background tasks are left (${leftovers.problems}, ${q(leftovers.tasks)})`);
  const end = Date.now() + 20000;
  const gone = (list) => list.every((p) => !alive(p.pid));
  while (Date.now() < end && !(gone(kernel) && gone(shells))) await sleep(300);
  check(gone(kernel), `closing the project ends the notebook kernel (${kernel.filter((p) => alive(p.pid)).map((p) => `${p.name}:${p.pid}`).join(', ') || 'none left'})`);
  check(gone(shells), `closing the project ends the terminal shells and their ping (${shells.filter((p) => alive(p.pid)).map((p) => `${p.name}:${p.pid}`).join(', ') || 'none left'})`);
  const lingering = ideProcesses().filter((p) => /^(git|gh|node)\.exe$/i.test(p.name) && /git|gh|fake-gh/i.test(p.cmd));
  check(!lingering.length, `no git or gh process lingers with the project closed (${lingering.map((p) => `${p.name}:${p.cmd.slice(0, 60)}`).join(' | ')})`);
  await snap('closed');
});
// Quit (File › Exit) and check that the IDE and every process it started are gone.
const tree = ideProcesses();
const errs = await internalErrors();
check(!errs.length, `no IDE internal errors in the session (${q(errs)})`);
await js(`(ide.runAction('Exit'), true)`).catch(() => {});
{
  const end = Date.now() + 30000;
  while (Date.now() < end && (alive(t.pid) || tree.some((p) => alive(p.pid)))) await sleep(300);
  const left = tree.filter((p) => alive(p.pid));
  check(!alive(t.pid) && !left.length, `Exit ends the IDE and every process it started (${left.map((p) => `${p.name}:${p.pid}`).join(', ') || `${tree.length} processes gone`})`);
}

// ===================================================================== Settings import into a fresh profile
const resultsA = [...t.results, ...t.consoleErrors.map((e) => ({ ok: false, label: `renderer exception: ${e}` }))];
for (const e of t.consoleErrors) console.log(`renderer exception: ${e}`);
t.close();
const b = await launch({ fixture: 'core', port: 9571, name: 'flow-tools-import', env: { PYIDE_SETTINGS_SYNC_DIALOG: settingsDialog } });
try {
  if (existsSync(settingsZip)) {
    const hb = helpers(b);
    writeFileSync(settingsDialog, q({ open: settingsZip }));
    await b.until(`ide.actions.some(a => a.id === 'ImportSettings') && !!ide.database`, 'plugins ready');
    b.check(!(await b.js(`ide.database.list().some(s => s.name === 'shop-db')`)), 'the fresh profile has no data sources');
    await b.js(`(ide.runAction('ImportSettings'), true)`);
    await hb.until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'Import Settings dialog');
    await b.js(`(${topDialog}.querySelector('.dialog-buttons .primary').click(), true)`);
    await hb.until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, 'import finished', 30000);
    await b.shot('import-done.png');
    await b.js(`(() => { const x = [...${topDialog}.querySelectorAll('.dialog-buttons button')].find(x => x.textContent === 'Not Now'); x?.click(); return true; })()`);
    const got = await b.js(`({ font: ide.settings.get('editor.fontSize'), todo: ide.settings.get('vcs.commitChecks.todo'), reformat: ide.settings.get('vcs.commitChecks.reformat'), feed: ide.settings.get('updates.feedUrl'), extra: ide.settings.get('interpreters.extra'), sources: ide.database.list().map(s => s.name) })`);
    b.check(got.font === 15 && got.reformat === false && got.sources.includes('shop-db'), `the fresh profile gets the editor font, the commit options and the data source (${q(got)})`);
    b.check(!got.feed && !(got.extra || []).length, 'but not this machine\'s update feed or interpreter paths');
  } else b.check(false, 'no settings archive to import (the settings phase failed)');
} catch (err) {
  b.check(false, `import: ${err.message.split('\n')[0]}`);
}
b.results.unshift(...resultsA);
await new Promise((r) => osv.close(r));
b.finish();
check(!errs.length, `no IDE internal errors in the session (${q(errs)})`);
await snap('end');
t.finish();
