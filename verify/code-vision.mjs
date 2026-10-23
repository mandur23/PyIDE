// Code vision (renderer/features/code-vision): "N usages" and the Git authors above Python classes and functions.
// Ports 9020-9022. A temp git repository from verify/fixtures/code-vision with commits by three authors (Jane Doe,
// 김철수, John Smith). Instance A: the declarations, counts equal to Pyright's references (and hand-checked ones),
// lazy counting of the code in view only, authors ("John Smith +2"), the usages popup / navigation / Find tool window,
// the commits popup and Annotate, counts updating after an edit in another file, authors after a save and a commit,
// a bounded number of references requests while typing 200 characters, none in Power Save Mode, the settings, an
// untracked file. Instance B: Korean, no repository. Instance C: an untrusted project in Safe Mode runs no git blame.
import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'code-vision');

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-codevision-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });

function makeRepo(prefix) {
  const project = path.join(mkdtempSync(path.join(tmpdir(), `pyide-${prefix}-`)), 'proj');
  cpSync(FIXTURE, project, { recursive: true });
  const git = (args, env = {}) => execFileSync('git', args, { cwd: project, stdio: 'ignore', env: { ...process.env, ...env } });
  const commit = (name, email, date, msg) => git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-qam', msg],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const edit = (from, to) => {
    const f = path.join(project, 'shapes.py');
    writeFileSync(f, readFileSync(f, 'utf8').replace(from, to));
  };
  git(['init', '-q']);
  git(['add', '-A']);
  commit('Jane Doe', 'jane@example.com', '2024-01-01T10:00:00', 'Add shapes');
  edit('return self.side * self.side', 'return self.side ** 2');
  commit('김철수', 'kim@example.com', '2024-02-01T10:00:00', 'Square area as a power');
  edit('self.side = side', 'self.side = float(side)');
  commit('John Smith', 'john@example.com', '2024-03-01T10:00:00', 'Store the side as a float');
  return project;
}

// Page helpers: the lens of a declaration by its qualified name ('usages' | 'authors' title, 'pending', or null).
const HELPERS = `(() => {
  window.__cvModel = (rel) => ide.getDocument(ide.util.joinPath(ide.root, rel))?.model;
  window.__cv = (rel, qual, kind) => {
    const m = __cvModel(rel);
    if (!m) return null;
    const s = ide.codeVision.symbols(m).find((x) => x.qual === qual);
    if (!s) return null;
    const ls = ide.codeVision.lenses(m).filter((l) => l.line === s.line);
    const hit = ls.find((l) => l.kind === kind);
    return hit ? hit.title : ls.some((l) => l.kind === 'pending') && kind === 'usages' ? 'pending' : null;
  };
  // Lens texts drawn in view in an editor (Monaco's DOM), by group index. Monaco redraws a lens when it comes into view,
  // so lenses out of view may still show older text.
  window.__cvDom = (i = 0) => {
    const host = ide.editors()[i].getContainerDomNode();
    const box = host.getBoundingClientRect();
    return [...host.querySelectorAll('.codelens-decoration > a')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    }).map((a) => a.textContent);
  };
  window.__refs = [];
  const inv = ide.api.invoke;
  ide.api.invoke = function (ch, method, ...rest) {
    if (ch === 'lsp:request' && method === 'textDocument/references') __refs.push(performance.now());
    return inv.call(this, ch, method, ...rest);
  };
  return true;
})()`;

// A new empty line at `line` of the editor in group `group` (a model edit, so no auto-indent), with the caret on it.
const newLine = (t, group, line) => t.js(`(() => {
  const ed = ide.editors()[${group}];
  ed.getModel().pushEditOperations([], [{ range: new ide.monaco.Range(${line}, 1, ${line}, 1), text: String.fromCharCode(10) }], () => null);
  ed.focus();
  ed.setPosition({ lineNumber: ${line}, column: 1 });
  return true;
})()`);

// line: the lens line of the declaration (its lens sits right above that line), when other declarations in view have
// a lens with the same text; waits for that lens to be drawn.
async function clickLens(t, text, group = 0, line = null) {
  const find = () => t.js(`(() => {
    const ed = ide.editors()[${group}];
    const host = ed.getContainerDomNode();
    const box = host.getBoundingClientRect();
    const lineTop = ${line} === null ? null : box.top + ed.getTopForLineNumber(${line}) - ed.getScrollTop();
    const a = [...host.querySelectorAll('.codelens-decoration > a')].find((n) => {
      const r = n.getBoundingClientRect();
      return n.textContent === ${S(text)} && r.height > 0 && r.top >= box.top && r.bottom <= box.bottom
        && (lineTop === null || (r.bottom <= lineTop + 1 && r.bottom >= lineTop - 2 * r.height));
    });
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  let box = await find();
  for (let i = 0; line !== null && !box && i < 50; i++) { await t.sleep(200); box = await find(); }
  if (!box) throw new Error(`no lens "${text}"`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await t.sleep(100);
}
const popupItems = (t) => t.js(`document.querySelector('#popup:not(.hidden)') ? [...document.querySelectorAll('#popupList .popup-item')].map((r) => r.textContent) : null`);
const pickPopup = (t, label) => t.js(`(() => {
  const row = [...document.querySelectorAll('#popupList .popup-item')].find((r) => r.querySelector('.label')?.textContent === ${S(label)});
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return true;
})()`);

let failed = false;
const run = async (name, fn) => {
  try { await fn(); } catch (err) { console.log(`FAIL ${name}: ${err.stack || err.message}`); failed = true; }
};

// ================= A: English, a repository with three authors =================
await run('A', async () => {
  const project = makeRepo('codevision');
  const t = await launch({ fixture: 'code-vision', port: 9020, name: 'code-vision', projectDir: project });
  const { js, until, check, sleep } = t;
  const cv = (rel, qual, kind) => js(`__cv(${S(rel)}, ${S(qual)}, ${S(kind)})`);
  // Scrolls the declaration into the middle of the editor that shows its file.
  const reveal = (rel, qual) => js(`(() => {
    const m = __cvModel(${S(rel)});
    const s = ide.codeVision.symbols(m).find((x) => x.qual === ${S(qual)});
    ide.editors().find((e) => e.getModel() === m).revealLineInCenter(s.line);
    return true;
  })()`);
  const untilLens = (rel, qual, kind, want, label, ms = 30000) =>
    until(`__cv(${S(rel)}, ${S(qual)}, ${S(kind)}) === ${S(want)}`, label || `${qual} ${kind} = ${want}`, ms);
  try {
    await js(HELPERS);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`!!__cvModel('shapes.py')`, 'shapes.py open');
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);

    // ---- declarations ----
    const quals = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).map((s) => s.qual)`);
    const want = ['Shape', 'Shape.area', 'Shape.describe', 'Square', 'Square.__init__', 'Square.area', 'Square.Meta', 'Point', 'make_square', 'load_shapes', 'unused_helper', '인사'];
    check(S(quals) === S(want), `declarations: top-level and class-level classes and functions only (${quals.join(', ')})`);
    const point = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).find((s) => s.qual === 'Point')`);
    check(point.line === 29 && point.nameLine === 30, 'the lens of a decorated class sits above its decorator');
    const load = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).find((s) => s.qual === 'load_shapes')`);
    check(load.end === 104, `a function's body ends at its last line (load_shapes ends at ${load.end})`);

    // ---- counts of the code in view only ----
    await untilLens('shapes.py', 'Shape', 'usages', '4 usages', 'Shape counted (import, base class and annotations)', 60000);
    await until(`!ide.codeVision.stats().running && !ide.codeVision.stats().scheduled`, 'first counts done', 30000);
    const view = await js(`(() => { const r = ide.editor.getVisibleRanges(); return { from: r[0].startLineNumber, to: r[r.length - 1].endLineNumber }; })()`);
    const below = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).filter((s) => s.line > ${view.to} + 2).map((s) => s.qual)`);
    const pending = [];
    for (const q of below) pending.push(await cv('shapes.py', q, 'usages'));
    check(below.length >= 3 && pending.every((p) => p === 'pending'), `declarations below the view (lines ${view.from}-${view.to}) are not counted yet (${below.join(', ')}: ${pending.join(', ')})`);
    const firstRefs = await js(`__refs.length`);
    const shown = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).filter((s) => s.line <= ${view.to} + 1).length`);
    check(firstRefs <= shown, `opening the file asks ${firstRefs} references requests for the ${shown} declarations in view`);
    await until(`__cvDom().includes('4 usages')`, 'count drawn');
    check(await js(`(() => {
      const d = ide.editors()[0].getContainerDomNode().querySelector('.codelens-decoration');
      return [...d.children].filter((n, i) => i % 2 === 1).every((n) => getComputedStyle(n).display === 'none');
    })()`), 'the editor draws the counts above the lines, without " | " separators');

    // Every count is what Pyright's references say (Find Usages shows the same), once the declaration is in view.
    const all = await js(`ide.codeVision.symbols(__cvModel('shapes.py')).map((s) => s.qual)`);
    const mismatch = [];
    for (const q of all) {
      await reveal('shapes.py', q);
      await until(`(() => { const v = __cv('shapes.py', ${S(q)}, 'usages'); return v && v !== 'pending'; })()`, `${q} counted`, 30000);
      const r = await js(`(async () => {
        const m = __cvModel('shapes.py');
        const s = ide.codeVision.symbols(m).find((x) => x.qual === ${S(q)});
        const refs = await ide.lsp.request('textDocument/references', { textDocument: { uri: m.uri.toString() }, position: { line: s.nameLine - 1, character: s.nameCol - 1 }, context: { includeDeclaration: false } });
        const n = refs.length;
        return { title: __cv('shapes.py', s.qual, 'usages'), expect: n === 0 ? 'no usages' : n === 1 ? '1 usage' : n + ' usages' };
      })()`);
      if (r.title !== r.expect) mismatch.push(`${q}: ${r.title} != ${r.expect}`);
    }
    check(mismatch.length === 0, `every count equals Pyright's references ${mismatch.join('; ')}`);
    const counts = {};
    for (const q of ['Square', 'Point', 'make_square', 'unused_helper', '인사']) counts[q] = await cv('shapes.py', q, 'usages');
    check(S(counts) === S({ Square: '3 usages', Point: '2 usages', make_square: '4 usages', unused_helper: 'no usages', 인사: '2 usages' }),
      `hand-checked counts, a Korean function name included ${S(counts)}`);

    // ---- authors ----
    await reveal('shapes.py', 'Square');
    await untilLens('shapes.py', 'Square', 'authors', 'John Smith +2', 'Square: John Smith +2');
    check(await cv('shapes.py', 'Square.area', 'authors') === '김철수 +1', `Square.area: 김철수 +1 (${await cv('shapes.py', 'Square.area', 'authors')})`);
    check(await cv('shapes.py', 'Square.__init__', 'authors') === 'John Smith +1', 'Square.__init__: John Smith +1');
    check(await cv('shapes.py', 'make_square', 'authors') === 'Jane Doe' && await cv('shapes.py', 'Shape', 'authors') === 'Jane Doe', 'one author: Jane Doe');
    check(await js(`ide.codeVision.stats().blames`) === 1, 'one git blame for the file');
    await until(`__cvDom().includes('John Smith +2')`, 'authors drawn');
    check(true, 'the editor draws the authors');

    // ---- clicks ----
    await until(`__cvDom().includes('3 usages')`, 'Square count drawn');
    await clickLens(t, '3 usages'); // Square
    await until(`!!document.querySelector('#popup:not(.hidden)')`, 'usages popup');
    const items = await popupItems(t);
    check(items.length === 4 && items.some((x) => x.includes('app.py:11')) && items.some((x) => x.includes('shapes.py:')) && /Open in Find Tool Window/.test(items[3]),
      `"3 usages" opens a popup with the usages and Open in Find Tool Window (${items.join(' | ')})`);
    await pickPopup(t, 'c = Square(4)');
    await until(`ide.activeTab()?.title === 'app.py' && ide.editor.getPosition().lineNumber === 11`, 'navigated to the usage');
    check(true, 'choosing a usage opens it');
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`ide.activeTab()?.title === 'shapes.py'`, 'back to shapes.py');
    await reveal('shapes.py', 'Square');
    await until(`__cvDom().includes('3 usages')`, 'lens drawn again');
    await clickLens(t, '3 usages');
    await until(`!!document.querySelector('#popup:not(.hidden)')`, 'usages popup again');
    await pickPopup(t, 'Open in Find Tool Window');
    await until(`document.querySelectorAll('#lspFindList .lsp-find-row').length === 3`, 'Find tool window with 3 usages');
    check(true, 'Open in Find Tool Window lists the usages in the Find tool window');

    // One usage: the click goes there.
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'app.py'))`);
    await until(`ide.activeTab()?.title === 'app.py'`, 'app.py');
    // main has "1 usage" too, and in a short editor (the CI runner's small screen) app.py may be scrolled past
    // total_area, so the click aims at total_area's lens.
    await reveal('app.py', 'total_area');
    await untilLens('app.py', 'total_area', 'usages', '1 usage', 'total_area: 1 usage');
    await until(`__cvDom().includes('1 usage')`, '1 usage drawn');
    await clickLens(t, '1 usage', 0, await js(`ide.codeVision.symbols(__cvModel('app.py')).find((s) => s.qual === 'total_area').line`));
    await until(`ide.editor.getPosition().lineNumber === 13`, 'navigated to the only usage');
    check(true, '"1 usage" goes straight to the usage');

    // Authors: the commits, and Annotate.
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`ide.activeTab()?.title === 'shapes.py'`, 'shapes.py');
    await reveal('shapes.py', 'Square');
    await until(`__cvDom().includes('John Smith +2')`, 'author lens drawn');
    await clickLens(t, 'John Smith +2');
    await until(`!!document.querySelector('#popup:not(.hidden)')`, 'commits popup');
    const commits = await popupItems(t);
    check(commits.length === 4 && /Annotate with Git Blame/.test(commits[0]) && /Store the side as a float/.test(commits[1]) && /Square area as a power/.test(commits[2]) && /Add shapes/.test(commits[3]),
      `the authors lens lists Annotate and the commits, newest first (${commits.join(' | ')})`);
    await pickPopup(t, 'Annotate with Git Blame');
    await until(`__cvModel('shapes.py').getAllDecorations().some((d) => /vcs-blame/.test(d.options.linesDecorationsClassName || ''))`, 'annotations shown');
    check(true, 'Annotate with Git Blame annotates the file');
    await js(`(ide.runAction('Annotate'), true)`);

    // ---- an edit in another file updates the count (after the pause) ----
    await js(`(ide.editor.revealLineInCenter(97), true)`);
    await untilLens('shapes.py', 'make_square', 'usages', '4 usages', 'make_square 4');
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'app.py'), { group: 'right' })`);
    await until(`ide.editors().length === 2 && ide.editors()[1].getModel() === __cvModel('app.py')`, 'app.py on the right');
    await newLine(t, 1, 11);
    for (const ch of '    d = make_square(5)') await t.type(ch);
    await untilLens('shapes.py', 'make_square', 'usages', '5 usages', 'make_square: 5 usages after the edit in app.py');
    check(true, 'a new call in another open file updates the count');

    // ---- a save blames again: uncommitted lines mark the author ----
    const blames0 = await js(`ide.codeVision.stats().blames`);
    await js(`(() => {
      const m = __cvModel('shapes.py');
      m.pushEditOperations([], [{ range: new ide.monaco.Range(98, 1, 98, 1), text: '    # tweak\\n' }], () => null);
      return true;
    })()`);
    await sleep(2500);
    check(await js(`ide.codeVision.stats().blames`) === blames0, 'editing does not run git blame');
    await js(`ide.saveAll().then(() => true)`);
    await untilLens('shapes.py', 'make_square', 'authors', 'Jane Doe *', 'make_square: Jane Doe * after the save');
    check(await js(`ide.codeVision.stats().blames`) === blames0 + 1 || await js(`ide.codeVision.stats().blames`) === blames0 + 2, 'a save runs one git blame per open file');
    check(await cv('shapes.py', 'Square', 'authors') === 'John Smith +2', 'other declarations keep their authors');
    // A commit (HEAD moves): blamed again with the new author.
    execFileSync('git', ['commit', '-qam', 'Tweak make_square'], { cwd: project, stdio: 'ignore' });
    await js(`ide.vcs.refresh().then(() => true)`);
    await untilLens('shapes.py', 'make_square', 'authors', 'Test User +1', 'make_square: Test User +1 after the commit');
    check(true, 'a new HEAD blames again');

    // ---- typing 200 characters: no request storm ----
    await until(`!ide.codeVision.stats().running && !ide.codeVision.stats().scheduled`, 'quiet before typing', 30000);
    await sleep(1500);
    const typed = '    y = ' + 'make_square(1) + total_area([]) + len("코드 비전") + '.repeat(5);
    await newLine(t, 1, 12);
    await js(`(__refs.length = 0, true)`);
    const typeStart = Date.now();
    for (const ch of typed.slice(0, 200)) await t.type(ch);
    const typingMs = Date.now() - typeStart;
    const during = await js(`__refs.length`);
    await sleep(6000);
    await until(`!ide.codeVision.stats().running && !ide.codeVision.stats().scheduled`, 'quiet after typing', 30000);
    const after = await js(`__refs.length`);
    const visible = await js(`(() => {
      let n = 0;
      for (const ed of ide.editors()) {
        const r = ed.getVisibleRanges();
        n += ide.codeVision.symbols(ed.getModel()).filter((s) => s.line >= r[0].startLineNumber - 1 && s.line <= r[r.length - 1].endLineNumber + 1).length;
      }
      return n;
    })()`);
    console.log(`typing 200 chars in ${typingMs} ms: ${during} references requests while typing, ${after} in all (${visible} declarations in view)`);
    check(during <= 1, `typing 200 characters sends ${during} references requests while typing (<= 1)`);
    check(after <= visible, `after typing: ${after} references requests in all, at most one per declaration in view (${visible})`);
    // Only declarations in view are counted; a short editor (the CI runner's small screen) may have scrolled past it.
    await js(`(ide.editors()[1].revealLineInCenter(ide.codeVision.symbols(__cvModel('app.py')).find((s) => s.qual === 'total_area').line), true)`);
    await untilLens('app.py', 'total_area', 'usages', '5 usages', 'total_area recounted after typing');
    check(true, 'the counts follow the typed calls once typing pauses');

    // ---- Power Save Mode ----
    await js(`(ide.powerSave.set(true), true)`);
    await until(`ide.editors().every((ed) => !ed.getContainerDomNode().querySelector('.codelens-decoration'))`, 'lenses gone in Power Save Mode');
    check(true, 'Power Save Mode hides code vision');
    const b0 = await js(`(__refs.length = 0, ide.codeVision.stats().blames)`);
    await newLine(t, 1, 12);
    for (const ch of '    z = make_square(9)') await t.type(ch);
    await js(`ide.saveAll().then(() => true)`);
    await sleep(4000);
    check(await js(`__refs.length`) === 0 && await js(`ide.codeVision.stats().blames`) === b0, 'no references requests and no git blame in Power Save Mode');
    await js(`(ide.powerSave.set(false), true)`);
    await until(`__cvDom(0).length > 0 && __cvDom(1).length > 0`, 'lenses back after Power Save Mode');
    await untilLens('shapes.py', 'make_square', 'usages', '10 usages', 'make_square recounted after Power Save Mode');
    check(true, 'turning Power Save Mode off brings the lenses back and recounts');

    // ---- settings ----
    await js(`(ide.openSettings('code-vision'), true)`);
    await until(`document.querySelector('.settings-page')?.dataset.page === 'code-vision'`, 'Code Vision settings page');
    check(await js(`['editor.codeVision.usages', 'editor.codeVision.authors'].every((k) => document.querySelector('[data-key="' + k + '"]')?.checked)`), 'Settings › Editor › Code Vision: Usages and Code author, on by default');
    await js(`(document.querySelector('[data-key="editor.codeVision.usages"]').click(), document.querySelector('#settingsOk').click(), true)`);
    await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
    check(await js(`ide.settings.get('editor.codeVision.usages')`) === false, 'unticking Usages turns the setting off');
    await until(`!__cvDom(0).some((x) => /usage/.test(x)) && __cvDom(0).some((x) => /Jane Doe|John Smith|Test User/.test(x))`, 'only authors drawn')
      .catch(async (e) => { console.log(S(await js(`({ dom: __cvDom(0), lenses: ide.codeVision.lenses(ide.editors()[0].getModel()), vr: ide.editors()[0].getVisibleRanges() })`))); throw e; });
    check(true, 'Usages off: only the authors are drawn');
    await js(`(ide.settings.set('editor.codeVision.authors', false), true)`);
    await until(`ide.editors().every((ed) => !ed.getContainerDomNode().querySelector('.codelens-decoration'))`, 'no lenses with both off');
    check(true, 'both off: no code vision');
    await js(`(__refs.length = 0, true)`);
    await newLine(t, 1, 12);
    for (const ch of '    w = make_square(8)') await t.type(ch);
    await sleep(3000);
    check(await js(`__refs.length`) === 0, 'no references requests with code vision off');
    await js(`(ide.settings.set('editor.codeVision.usages', true), ide.settings.set('editor.codeVision.authors', true), true)`);
    await until(`__cvDom(0).length > 0`, 'lenses back');

    // ---- a file Git does not track: no authors ----
    writeFileSync(path.join(project, 'extra.py'), 'def extra():\n    return 1\n');
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'extra.py'))`);
    await untilLens('extra.py', 'extra', 'usages', 'no usages', 'extra.py counted');
    await sleep(1500);
    check(await cv('extra.py', 'extra', 'authors') === null, 'an untracked file shows no authors');

    check((await js(`[...i18n.missing]`)).length === 0, 'no missing translations');
  } catch (err) {
    check(false, err.stack || err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
});

// ================= B: Korean, no repository =================
await run('B', async () => {
  const t = await launch({ fixture: 'code-vision', port: 9021, name: 'code-vision-ko', lang: 'ko-KR' });
  const { js, until, check } = t;
  try {
    await js(HELPERS);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`!!__cvModel('shapes.py')`, 'shapes.py open');
    await until(`__cv('shapes.py', 'Shape', 'usages') === '사용 위치 4개'`, 'Korean count', 60000);
    await until(`__cvDom().includes('사용 위치 4개')`, 'Korean count drawn');
    check(true, 'Korean: 사용 위치 4개');
    // Counted once in view: centred, since a short editor (the CI runner's small screen) showing the last lines may
    // not show unused_helper.
    await js(`(ide.editor.revealLineInCenter(ide.codeVision.symbols(__cvModel('shapes.py')).find((s) => s.qual === 'unused_helper').line), true)`);
    await until(`__cv('shapes.py', 'unused_helper', 'usages') === '사용 위치 없음'`, 'Korean no usages', 30000);
    check(true, 'Korean: 사용 위치 없음');
    check(await js(`__cv('shapes.py', 'Shape', 'authors')`) === null && await js(`ide.codeVision.stats().blames`) === 0, 'a project that is not a Git repository runs no git blame and shows no authors');
    await js(`(ide.openSettings('code-vision'), true)`);
    await until(`document.querySelector('.settings-page')?.dataset.page === 'code-vision'`, 'Code Vision settings page');
    const leaks = await englishLeaks(t, '.settings-dialog');
    check(leaks.length === 0, `the Code Vision settings page is Korean ${S(leaks)}`);
    check(await js(`[...document.querySelectorAll('.settings-nav-row')].some((r) => r.textContent.includes('코드 비전'))`), 'Settings lists 코드 비전 under Editor');
    await js(`(document.querySelector('#settingsCancel').click(), true)`);
    const missing = await missingTranslations(t);
    check(missing.length === 0, `no missing translations ${S(missing)}`);
  } catch (err) {
    check(false, err.stack || err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
});

// ================= C: an untrusted repository in Safe Mode =================
await run('C', async () => {
  const repo = makeRepo('codevision-untrusted');
  const work = mkdtempSync(path.join(tmpdir(), 'pyide-codevision-trust-'));
  const home = path.join(work, 'home');
  cpSync(path.join(import.meta.dirname, 'fixtures', 'core'), home, { recursive: true });
  const userData = path.join(work, 'userdata');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ recentProjects: [{ path: home, opened: Date.now() }] }));
  const t = await launch({ fixture: 'core', port: 9022, name: 'code-vision-untrusted', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } });
  const { js, until, check, sleep } = t;
  try {
    js(`ide.openProject(${S(repo)})`);
    await until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent.includes('Trust and Open Project?'))`, 'trust question');
    await js(`([...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Preview in Safe Mode').click(), true)`);
    await until(`ide.root && ide.util.samePath(ide.root, ${S(repo)}) && ide.trusted === false`, 'opened in Safe Mode');
    await js(HELPERS);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'shapes.py'))`);
    await until(`!!__cvModel('shapes.py')`, 'shapes.py open');
    await until(`ide.lsp.status() !== 'starting' && ide.lsp.status() !== 'off'`, 'Pyright settled', 60000).catch(() => {});
    await sleep(5000);
    check(await js(`ide.codeVision.stats().blames`) === 0 && await js(`__cv('shapes.py', 'Square', 'authors')`) === null, 'Safe Mode: no git blame and no authors');
  } catch (err) {
    check(false, err.stack || err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
});

console.log(failed ? 'code-vision: FAILED' : 'code-vision: all passed');
process.exit(failed ? 1 : 0);
