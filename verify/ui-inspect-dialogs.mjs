// Dialogs and Settings in a small window (900x560), in Korean (the longest labels) and the Light theme, from the 0.2.4
// inspection: every Settings page and the dialogs a user opens most stay inside the window with their buttons on
// screen, settings controls line up (a hint never squeezes its control, and goes under it in a small window), the
// keyboard starts inside a dialog, Tab never leaves it or lands on the page, the focus ring is the IDE's blue, the
// primary button comes first, and Esc closes. Plus the fixes found there: Template variables names are never cut off,
// About keeps its labels on one line, Share Project on GitHub puts Private under the inputs, the Conflicts dialog's file
// list takes the keyboard (Up/Down, Enter merges) and ends long names with an ellipsis, the commit buttons keep
// one-line labels beside the commit checks' progress, Install Manager cards never scroll sideways, and the Review
// tab's Warning label is readable in Light. Git runs against a throwaway global config; GitHub is the fake gh
// (verify/fixtures/github). Port 9494.
import { execFileSync } from 'child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-ui-inspect-dialogs-'));
const gitConfig = path.join(work, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Octo Cat\n\temail = octocat@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const project = path.join(work, 'project');
cpSync(path.join(HERE, 'fixtures', 'core'), project, { recursive: true });
git(project, 'init', '-q');
git(project, 'add', '.');
git(project, 'commit', '-qm', 'Initial commit');
const bin = path.join(work, 'bin');
mkdirSync(bin);
for (const f of ['gh.cmd', 'fake-gh.js']) copyFileSync(path.join(HERE, 'fixtures', 'github', f), path.join(bin, f));
writeFileSync(path.join(work, 'gh-state.json'), q({ auth: 'in', account: 'octocat', prs: [], views: {} }));

const t = await launch({ fixture: 'core', projectDir: project, port: 9494, name: 'inspect-dialogs', lang: 'ko-KR', env: {
  PYIDE_GH: path.join(bin, 'gh.cmd'), FAKE_GH_STATE: path.join(work, 'gh-state.json'), FAKE_GH_LOG: path.join(work, 'gh-log.jsonl'), PYIDE_FAKE_OPEN_EXTERNAL: '1',
} });
const { js, until, press, check, sleep, cdp } = t;
const W = 900;
const H = 560;
const TOP = `[...document.querySelectorAll('#dialogHost .dialog')].pop()`;
const dialogCount = () => js(`document.querySelectorAll('#dialogHost .dialog').length`);

// In the page: where a dialog and its footer buttons are, and what is cut off.
const GEOMETRY = `(root) => {
  const r = root.getBoundingClientRect();
  const out = [];
  if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push('dialog outside the window ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
  for (const b of root.querySelectorAll('.dialog-buttons button')) {
    if (!b.getClientRects().length) continue;
    const s = b.getBoundingClientRect();
    if (s.bottom > innerHeight + 0.5 || s.right > innerWidth + 0.5 || s.left < r.left - 0.5 || s.right > r.right + 0.5) out.push('button off screen: ' + b.textContent);
    if (b.scrollWidth > b.clientWidth + 1) out.push('button label cut: ' + b.textContent);
  }
  return out;
}`;
// A focused element's identity across Tab presses, and whether it shows the IDE's blue ring.
const FOCUS = `(root) => {
  const a = document.activeElement;
  if (!a.dataset.uiTab) a.dataset.uiTab = String((window.__uiTab = (window.__uiTab || 0) + 1));
  const s = getComputedStyle(a);
  const blue = getComputedStyle(document.documentElement).getPropertyValue('--blue6').trim();
  const probe = document.createElement('i'); probe.style.color = blue; document.body.appendChild(probe);
  const blueRgb = getComputedStyle(probe).color; probe.remove();
  return { inside: root.contains(a) && a !== root, body: a === document.body, id: a.dataset.uiTab, tag: a.tagName, type: a.type || '',
    text: (a.textContent || a.placeholder || '').trim().slice(0, 30), ringBlue: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor === blueRgb };
}`;

// Opens a dialog and checks its geometry, keyboard and button order; Esc closes it unless `close` is given.
async function dialog(name, open, { order = true, close, afterOpen, root = TOP } = {}) {
  const before = await dialogCount();
  await open();
  await until(`document.querySelectorAll('#dialogHost .dialog').length > ${before} && !!(${root})`, `${name} dialog`, 30000);
  await sleep(250);
  const geo = await js(`(${GEOMETRY})(${root})`);
  check(geo.length === 0, `${name}: fits the ${W}x${H} window with its buttons on screen${geo.length ? ` (${geo.join('; ')})` : ''}`);
  if (order) {
    const labels = await js(`[...(${root}).querySelectorAll('.dialog-buttons button')].map(b => (b.classList.contains('primary') ? '*' : '') + b.textContent)`);
    check(!labels.some((l) => l.startsWith('*')) || labels[0].startsWith('*'), `${name}: the primary button comes first (${labels.join(' | ')})`);
  }
  const first = await js(`(${FOCUS})(${root})`);
  await afterOpen?.();
  check(first.inside, `${name}: the keyboard starts inside the dialog (${first.tag} ${first.text})`);
  const seen = [];
  let left = null;
  let buttonRing = null;
  for (let i = 0; i < 30; i++) {
    await press('Tab');
    const f = await js(`(${FOCUS})(${root})`);
    if (!f.inside) { left = `${f.tag} ${f.text}`; break; }
    if (f.tag === 'BUTTON' && buttonRing === null) buttonRing = f.ringBlue;
    if (seen.includes(f.id)) break;
    seen.push(f.id);
  }
  check(left === null, `${name}: Tab cycles inside the dialog (${seen.length} stops${left ? `, left for ${left}` : ''})`);
  if (buttonRing !== null) check(buttonRing, `${name}: a button focused with Tab shows the blue focus ring`);
  if (close) await close();
  else {
    await press('Escape');
    await until(`document.querySelectorAll('#dialogHost .dialog').length === ${before}`, `${name} closes on Esc`, 5000);
    check(await js(`document.activeElement !== document.body`), `${name}: after Esc the keyboard is back somewhere, not on the page`);
  }
}

try {
  await openFile(t, 'hello.py');
  await js(`(ide.settings.set('appearance.theme', 'light'), ide.settings.set('vcs.autoFetchMinutes', 0), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  // ---------- Settings: every page ----------
  await js(`(ide.runAction('ShowSettings'), true)`);
  await until(`!!document.querySelector('.settings-dialog')`, 'settings');
  const pages = await js(`[...document.querySelectorAll('.settings-nav-row[data-page]')].map(n => n.dataset.page)`);
  const problems = [];
  for (const page of pages) {
    await js(`(() => { const r = document.querySelector('.settings-nav-row[data-page="${page}"]'); r.classList.remove('collapsed'); r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
    await until(`document.querySelector('.settings-page')?.dataset.page === '${page}'`, `page ${page}`);
    await sleep(150);
    const p = await js(`(() => {
      const out = (${GEOMETRY})(document.querySelector('.settings-dialog'));
      const pg = document.querySelector('.settings-page');
      if (pg.scrollWidth > pg.clientWidth + 1) out.push('page scrolls sideways');
      // the controls of a section's rows share one width, and a hint never sits beside a squeezed control
      for (const sec of pg.querySelectorAll('.settings-section')) {
        const ctl = [...sec.querySelectorAll(':scope > .field')].map(f => f.children[1]).filter(c => c && c.matches('input:not([type=checkbox]), select, .field-row') && c.getClientRects().length);
        const widths = [...new Set(ctl.map(c => Math.round(c.getBoundingClientRect().width)))];
        if (widths.length > 1) out.push('controls of different widths ' + widths.join('/'));
        for (const c of ctl) if (c.getBoundingClientRect().width < 119) out.push('narrow control ' + Math.round(c.getBoundingClientRect().width));
        for (const hint of sec.querySelectorAll(':scope > .field > .field-hint')) {
          const c = hint.parentElement.children[1].getBoundingClientRect();
          if (hint.getBoundingClientRect().top < c.bottom - 1) out.push('hint beside its control in a small window: ' + hint.textContent.slice(0, 20));
        }
      }
      return out;
    })()`);
    for (const m of p) problems.push(`${page}: ${m}`);
  }
  check(pages.length >= 25 && problems.length === 0, `all ${pages.length} Settings pages fit, scroll only down, and line up their controls${problems.length ? ` (${problems.join('; ')})` : ''}`);
  await js(`(() => { const r = document.querySelector('.settings-nav-row[data-page="updates"]'); r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'updates'`, 'updates page');
  await t.shot('after-settings-updates-ko-light-900.png');

  // Keymap › Add Keyboard Shortcut, a dialog over the Settings dialog, with a conflict shown.
  await js(`(() => { const r = document.querySelector('.settings-nav-row[data-page="keymap"]'); r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
  await until(`document.querySelectorAll('.keymap-row').length > 5`, 'keymap rows');
  await dialog('Keyboard Shortcut', async () => {
    await js(`(document.querySelectorAll('.keymap-row')[3].click(), document.querySelector('#keymapAdd').click(), true)`);
  });
  await press('Escape');
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');

  // ---------- dialogs ----------
  await dialog('New Project', () => js(`(ide.runAction('NewProject'), true)`));
  await js(`(() => {
    const py = (id, name) => ({ id, name, type: 'python', script: 'hello.py', params: '', cwd: '', env: '', envFiles: '.env', interp: '' });
    for (let i = 0; i < 18; i++) ide.run.configs().push(py('c' + i, '긴 이름의 실행 구성 ' + i));
    ide.run.configs().push({ ...py('target', 'Target'), beforeLaunch: [{ kind: 'config', id: 'c1' }, { kind: 'tool', name: 'Generate', program: 'node.exe', args: 'tool.js', cwd: '' }] });
    ide.run.select('target');
    return true;
  })()`);
  await dialog('Run/Debug Configurations', () => js(`(ide.run.editConfigurations('target'), true)`));
  await dialog('Export Settings', () => js(`(ide.runAction('ExportSettings'), true)`));
  await dialog('Create Virtual Environment', () => js(`(ide.runAction('CreateVirtualEnvironment'), true)`));
  await dialog('Save Layout As', () => js(`(ide.runAction('StoreNewLayout'), true)`));
  await dialog('Report a Problem', () => js(`(ide.runAction('ReportProblem'), true)`));
  await dialog('Debug Log Settings', () => js(`(ide.runAction('LogDebugConfigure'), true)`));
  await dialog('IDE Internal Errors', () => js(`(ide.runAction('ShowIdeErrors'), true)`));
  await dialog('Get from Version Control', () => js(`(ide.runAction('GetFromVcs'), true)`));
  await dialog('Attach to Process', () => press('Ctrl+Alt+F5'));
  // PyCharm's Find in Files puts Open in Find Window last, so the order is not checked there.
  await dialog('Find in Files', () => press('Ctrl+Shift+F'), { order: false });
  await dialog('Replace in Files', () => press('Ctrl+Shift+R'), { order: false });
  await dialog('New Data Source', async () => {
    await js(`(ide.runAction('Database.NewDataSource'), true)`);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(m => m.textContent.includes('PostgreSQL'))`, 'data source menu');
    await js(`([...document.querySelectorAll('.context-menu .menu-item')].find(m => m.textContent.includes('PostgreSQL')).classList.add('pick-me'), true)`);
    await t.click('.context-menu .menu-item.pick-me');
  });

  // Template variables: one grid, so every input starts at the same place and long names are never cut off.
  await dialog('Template variables', () => js(`(ide.fileTemplates.render({ name: 'Service', body: '\${AUTHOR_EMAIL} \${A_VERY_LONG_VARIABLE_NAME_FOR_TESTING} \${X}' }, ide.util.joinPath(ide.root, 'x.py')), true)`), {
    close: async () => {
      const g = await js(`(() => {
        const rows = [...document.querySelectorAll('.ft-var-row')];
        return { lefts: [...new Set(rows.map(r => Math.round(r.querySelector('input').getBoundingClientRect().left)))].length,
          cut: rows.filter(r => { const s = r.querySelector('span'); const sr = s.getBoundingClientRect(); return s.scrollWidth > s.clientWidth + 1 || sr.right > r.querySelector('input').getBoundingClientRect().left; }).map(r => r.querySelector('span').textContent),
          styled: rows.every(r => r.querySelector('input').classList.contains('input')) };
      })()`);
      check(g.lefts === 1 && g.cut.length === 0 && g.styled, `Template variables: the inputs line up and no name is cut off (${q(g)})`);
      await t.shot('after-template-vars-ko-light-900.png');
      await press('Escape');
    },
  });

  // About: the labels stay on one line in Korean.
  await dialog('About', () => js(`(ide.runAction('AboutPyIDE'), true)`), {
    close: async () => {
      const wrapped = await js(`[...document.querySelectorAll('.diag-facts tr')].filter(r => { const a = r.cells[0], b = r.cells[1]; const range = document.createRange(); range.selectNodeContents(a); return range.getClientRects().length > 1; }).map(r => r.cells[0].textContent)`);
      check(wrapped.length === 0, `About: every label is on one line (${q(wrapped)})`);
      await press('Escape');
    },
  });

  // Share Project on GitHub: Private sits under the inputs, not in the label column.
  await dialog('Share Project on GitHub', () => js(`(ide.runAction('Github.Share.Project'), true)`), {
    close: async () => {
      const x = await js(`(() => { const box = document.querySelector('.gh-share-private input').getBoundingClientRect().left; const input = document.querySelector('.gh-share-name').getBoundingClientRect().left; return { box: Math.round(box), input: Math.round(input) }; })()`);
      check(Math.abs(x.box - x.input) <= 2, `Share Project on GitHub: the Private check box lines up with the inputs (${q(x)})`);
      await press('Escape');
    },
  });

  // ---------- Commit window ----------
  writeFileSync(path.join(project, 'hello.py'), 'print("changed")\n');
  writeFileSync(path.join(project, 'module_with_a_long_file_name.py'), 'X = 1\n');
  await js(`ide.vcs.refresh().then(() => true)`);
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await until(`!!document.querySelector('#vcsCommitOptions') && document.querySelectorAll('.vcs-changes .vcs-file').length >= 2`, 'commit window with changes');
  // The commit checks' progress as it shows while a check runs.
  await js(`(() => { const p = document.querySelector('#vcsChecksProgress'); p.classList.remove('hidden'); p.querySelector('.vcs-checks-progress-text').textContent = '코드 분석 중… (2/3)'; return true; })()`);
  const commitRow = await js(`(() => {
    const lines = (n) => { const r = document.createRange(); r.selectNodeContents(n); return [...r.getClientRects()].map(c => Math.round(c.top)).filter((v, i, a) => a.indexOf(v) === i).length; };
    const row = document.querySelector('.vcs-commit-btns').getBoundingClientRect();
    return { commit: lines(document.querySelector('.vcs-commit-btn')), push: lines(document.querySelector('.vcs-commit-push-btn')), cancel: lines(document.querySelector('#vcsChecksCancel')),
      text: Math.round(document.querySelector('.vcs-checks-progress-text').getBoundingClientRect().width),
      inside: [...document.querySelectorAll('.vcs-commit-btns button, #vcsChecksCancel')].every(n => n.getBoundingClientRect().right <= row.right + 1) };
  })()`);
  check(commitRow.commit === 1 && commitRow.push === 1 && commitRow.cancel === 1 && commitRow.text >= 60 && commitRow.inside, `Commit window: the buttons and Cancel keep one-line labels and the checks' progress stays readable (${q(commitRow)})`);
  await t.shot('after-commit-window-ko-light-900.png');
  await js(`(document.querySelector('#vcsChecksProgress').classList.add('hidden'), true)`);
  // The Review tab's Warning label in Light: readable on white (it was the dark theme's yellow, 1.8:1).
  const contrast = await js(`(() => {
    const host = document.createElement('div'); host.className = 'vcs-checks-results'; host.style.background = '#fff';
    const s = document.createElement('span'); s.className = 'vcs-checks-sev warning'; s.textContent = '경고'; host.appendChild(s); document.body.appendChild(host);
    const [r, g, b] = getComputedStyle(s).color.match(/\\d+/g).map(Number); host.remove();
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return +(1.05 / (0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) + 0.05)).toFixed(2);
  })()`);
  check(contrast >= 4.5, `Review tab: the Warning label is readable in the Light theme (contrast ${contrast}:1)`);

  await dialog('Shelve Changes', () => js(`(ide.runAction('ChangesView.Shelve'), true)`));
  await dialog('Stash Changes', () => js(`(ide.runAction('Git.Stash'), true)`));

  // ---------- Install Manager in a narrow editor ----------
  await js(`(ide.installer.open(), true)`);
  await until(`document.querySelectorAll('#installCards .inst-card').length > 3`, 'install manager cards');
  const cards = await js(`(() => { const c = document.querySelector('#installCards'); return { scroll: c.scrollWidth, client: c.clientWidth }; })()`);
  check(cards.scroll <= cards.client + 1, `Install Manager: the cards fit the editor without a sideways scroll (${q(cards)})`);
  await js(`(ide.closeTab([...ide.tabs].find(x => x.kind !== 'file' && /Install|설치/.test(x.title))?.path || '', true), true)`).catch(() => {});

  // ---------- Conflicts ----------
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'wip');
  git(project, 'checkout', '-qb', 'feature');
  const LONG = 'requests_with_a_very_long_conflicting_file_name.http';
  writeFileSync(path.join(project, 'pkg', 'util.py'), 'def greet(n):\n    return "feature " + n\n');
  writeFileSync(path.join(project, LONG), 'GET http://feature\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'feature');
  git(project, 'checkout', '-q', 'main');
  writeFileSync(path.join(project, 'pkg', 'util.py'), 'def greet(n):\n    return "main " + n\n');
  writeFileSync(path.join(project, LONG), 'GET http://main\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'main');
  try { git(project, 'merge', 'feature'); } catch {}
  await js(`ide.vcs.refresh().then(() => true)`);
  await dialog('Conflicts', () => js(`(ide.runAction('Git.ResolveConflicts'), true)`), {
    afterOpen: async () => check(await js(`document.activeElement?.classList.contains('vcs-conflict-rows')`), 'Conflicts: the keyboard starts in the file list'),
    close: async () => {
      await js(`(document.querySelector('.vcs-conflict-rows').focus(), true)`);
      const firstSel = await js(`document.querySelector('.vcs-conflict-row.selected')?.dataset.path || ''`);
      await press('ArrowDown');
      const sel = await js(`document.querySelector('.vcs-conflict-row.selected')?.dataset.path || ''`);
      check(sel && sel !== firstSel, `Conflicts: Down selects the next file (${firstSel} -> ${sel})`);
      const name = await js(`(() => { const n = [...document.querySelectorAll('.vcs-conflict-row .vcs-name')].find(x => x.textContent === ${q(LONG)}); const s = getComputedStyle(n); return { cut: n.scrollWidth > n.clientWidth, ellipsis: s.textOverflow === 'ellipsis', right: Math.round(n.getBoundingClientRect().right), cell: Math.round(n.closest('.vcs-cf-name').getBoundingClientRect().right) }; })()`);
      check(name.ellipsis && name.right <= name.cell + 1, `Conflicts: a long file name ends with an ellipsis inside its column (${q(name)})`);
      await t.shot('after-conflicts-ko-light-900.png');
      await press('Enter');
      await until(`!document.querySelector('.dialog .vcs-conflicts') && ide.tabs.some(x => /^(Merge|병합)/.test(x.title || ''))`, 'Enter merges the selected file', 15000);
      check(true, 'Conflicts: Enter opens the merge tool for the selected file');
    },
  });
} catch (err) {
  check(false, `suite error: ${err.message}`);
}
t.finish();
