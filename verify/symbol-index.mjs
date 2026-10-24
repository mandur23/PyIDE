// The symbol index behind Go to Class and Search Everywhere (port 9066): the window keeps the index between popups
// and main sends only the files whose symbols changed (none for a second popup or a save inside a function body, one
// for a save that adds a class, a removal for a deleted file), and a reopened project lists its symbols from the
// index kept on disk without running Python, parsing again only the files changed since or parsed by another Python
// (major.minor and implementation).
//   node verify/symbol-index.mjs [--lang ko] [--viewport 1008x681]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const lang = arg('lang') || 'en-US';
const viewport = arg('viewport')?.split('x').map(Number);
const ko = lang.startsWith('ko');

const project = path.join(tempDir('symidx'), 'proj');
const moduleText = (p, m, extra = '') => [`"""Module ${p}.${m}."""`, '', ...[0, 1, 2].flatMap((c) => [`class Model${p}x${m}x${c}:`, '    def total(self, k):', `        return k + ${c}`, '', '']), extra].join('\n');
for (let p = 0; p < 4; p++) {
  mkdirSync(path.join(project, `pkg${p}`), { recursive: true });
  writeFileSync(path.join(project, `pkg${p}`, '__init__.py'), '');
  for (let m = 0; m < 10; m++) writeFileSync(path.join(project, `pkg${p}`, `mod${m}.py`), moduleText(p, m));
}

const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
const rows = `[...document.querySelectorAll('#popupList .popup-item:not(.hint) .label')].map((n) => n.textContent)`;
// Records each index reply the window receives: what it asked for and how much came back.
const HOOK = `(() => { window.__replies = []; const inv = ide.api.invoke;
  ide.api.invoke = function (ch, ...a) { const p = inv.call(this, ch, ...a);
    if (ch === 'search:symbolIndex') p.then((r) => __replies.push({ since: a[2], version: r.version, full: r.full, files: r.files.length, removed: r.removed.length, paths: r.files.map(([f]) => f.slice(-12)) }));
    return p; }; return 1; })()`;

async function session(userData) {
  const t = await launch({ fixture: 'core', port: 9066, name: `symbol-index-${lang}`, projectDir: project, userData, lang });
  if (viewport) {
    await t.cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
    await t.until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
  }
  await t.until('ide.root && ide.currentInterp()', 'project and interpreter');
  await t.js(HOOK);
  return t;
}

// Go to Class with real keys: the rows listed for `query`, then Escape.
async function gotoClass(t, query, expect) {
  await t.press('Ctrl+N');
  await t.until(popupOpen, 'Go to Class popup');
  await t.type(query);
  const ok = await t.until(`${rows}.some((r) => r === ${JSON.stringify(expect)})`, `Go to Class lists ${expect}`, 20000).then(() => true, () => false);
  const listed = await t.js(rows);
  await t.press('Escape');
  await t.until(`!(${popupOpen})`, 'popup closed');
  return { ok, listed };
}
const lastReply = (t) => t.js('__replies[__replies.length - 1]');
const settle = async (t) => { await t.until(`!ide.searchNav.indexing()`, 'index loads done', 30000); return lastReply(t); };

let t = await session();
const results = [];
const errors = [];
let storeDir;
const record = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
try {
  const first = await gotoClass(t, 'Model2x3x', 'Model2x3x1');
  const firstReply = await settle(t);
  const whole = await t.js('__replies.filter((r) => r.full).map((r) => r.files)');
  record(first.ok && whole.length >= 1 && whole.every((n) => n === 44), `Go to Class lists the project's classes; the window first receives the whole index (${whole.join(', ')} files)`);

  const again = await gotoClass(t, 'Model1x4x2', 'Model1x4x2');
  const againReply = await settle(t);
  record(again.ok && !againReply.full && againReply.files === 0 && againReply.removed === 0 && againReply.since === firstReply.version,
    `a second popup receives no symbols: the window keeps the index (${JSON.stringify(againReply)})`);

  await t.js(`ide.runAction('SearchEverywhere')`);
  await t.until(`!!document.querySelector('#seInput')`, 'Search Everywhere');
  await t.type('Model3x9x0');
  const seOk = await t.until(`[...document.querySelectorAll('#seList .se-row .se-label')].some((n) => n.textContent === 'Model3x9x0')`, 'Search Everywhere class', 15000).then(() => true, () => false);
  const seReply = await settle(t);
  await t.press('Escape');
  record(seOk && !seReply.full && seReply.files === 0, `Search Everywhere finds the class from the same index without receiving it again (${seReply.files} files)`);

  // A save that adds a class: one file comes back.
  await openFile(t, 'pkg0/mod0.py');
  await t.js(`(() => { const e = ide.editor.getModel().getFullModelRange().getEndPosition(); ide.editor.executeEdits('t', [{ range: { startLineNumber: e.lineNumber, startColumn: e.column, endLineNumber: e.lineNumber, endColumn: e.column }, text: '\\nclass AddedLater:\\n    pass\\n' }]); return 1; })()`);
  await t.press('Ctrl+S');
  await t.until('!ide.isDirty(ide.activeTab())', 'saved');
  const added = await gotoClass(t, 'AddedLat', 'AddedLater');
  const addedReply = await settle(t);
  record(added.ok && addedReply.files === 1 && /mod0\.py$/.test(addedReply.paths[0]), `a saved class is found; only its file is sent (${JSON.stringify(addedReply.paths)})`);

  // A save inside a function body leaves the symbols as they were: nothing is sent.
  await openFile(t, 'pkg0/mod1.py');
  await t.js(`(() => { const m = ide.editor.getModel(); const ln = m.findMatches('return k + 1', false, false, true, null, false)[0].range; ide.editor.executeEdits('t', [{ range: ln, text: 'return k + 100' }]); return 1; })()`);
  await t.press('Ctrl+S');
  await t.until('!ide.isDirty(ide.activeTab())', 'saved');
  await gotoClass(t, 'Model0x1x1', 'Model0x1x1');
  const bodyReply = await settle(t);
  record(bodyReply.files === 0 && bodyReply.version === addedReply.version, `a save inside a function body sends nothing (${bodyReply.files} files, version ${addedReply.version} -> ${bodyReply.version})`);

  // A file deleted outside the IDE drops out of the window's index.
  rmSync(path.join(project, 'pkg1', 'mod7.py'));
  await t.sleep(500);
  await gotoClass(t, 'Model1x6x0', 'Model1x6x0');
  const goneReply = await settle(t);
  const goneLeft = await t.js(`ide.searchNav.symbols().then((s) => s.filter((x) => x.name.startsWith('Model1x7x')).length)`);
  record(goneReply.removed === 1 && goneLeft === 0, `a deleted file's classes are gone from the window's index (${goneReply.removed} removed, ${goneLeft} left)`);

  if (ko) {
    await t.press('Ctrl+N');
    await t.until(popupOpen, 'Go to Class popup');
    await t.type('Model');
    await t.until(`${rows}.length > 0`, 'rows');
    // Class names and paths are the user's; the kind column is UI text.
    const kinds = await t.js(`[...new Set([...document.querySelectorAll('#popup .hint-right')].map((n) => n.textContent))]`);
    const leaks = await englishLeaks(t, '#popup .hint-right');
    await t.press('Escape');
    record(kinds.length && !leaks.length, `Go to Class in Korean has no English UI text (kinds: ${kinds.join(', ')}; ${JSON.stringify(leaks).slice(0, 200)})`);
    const missing = await missingTranslations(t);
    record(!missing.length, `no missing Korean translations (${missing.join(', ')})`);
  }

  // The index on disk is written after a build that changed something.
  storeDir = path.join(t.userData, 'symbol-index');
  let stored = '';
  for (let i = 0; i < 50 && !/AddedLater/.test(stored); i++) {
    await t.sleep(100);
    stored = existsSync(storeDir) ? readdirSync(storeDir).filter((n) => n.endsWith('.json')).map((n) => readFileSync(path.join(storeDir, n), 'utf8')).join('') : '';
  }
  record(/AddedLater/.test(stored) && !/Model1x7x/.test(stored), 'the index is kept on disk with the saved class and without the deleted file');
  const userData = t.userData;
  errors.push(...t.consoleErrors);
  t.close();

  // Between the sessions one module changes on disk (a new mtime).
  writeFileSync(path.join(project, 'pkg3', 'mod3.py'), moduleText(3, 3, 'class ChangedWhileClosed:\n    pass\n'));
  t = await session(userData);
  const broken = await t.js(`ide.api.invoke('search:symbolIndex', { cmd: 'C:/no/such/python.exe', args: [] }, ide.root, 0).then((r) => r.files.flatMap(([, s]) => s).filter((x) => x.kind === 'class').map((x) => x.name))`);
  record(broken.includes('Model2x5x1') && broken.includes('AddedLater') && !broken.includes('ChangedWhileClosed'),
    `a reopened project lists its classes from the index on disk without Python (${broken.length} classes with an interpreter that does not exist)`);
  const reopened = await gotoClass(t, 'ChangedWhile', 'ChangedWhileClosed');
  await settle(t);
  record(reopened.ok, `a module changed while the project was closed is parsed again (${reopened.listed.slice(0, 3).join(', ')})`);
  const kept = await gotoClass(t, 'AddedLat', 'AddedLater');
  record(kept.ok, 'classes from the index on disk are listed after the reopen');

  // A parse depends on the Python that made it. The stand-in for Python 3.11 is the same Python reporting 3.11 and
  // parsing with the 3.11 grammar, so it cannot read `class Box[T]` (3.12) and finds no classes in models.py.
  writeFileSync(path.join(project, '..', 'py311.py'), ['import ast, functools, sys', 'sys.version_info = (3, 11, 0, "final", 0)',
    'ast.parse = functools.partial(ast.parse, feature_version=(3, 11))', 'code = sys.argv[2]', 'sys.argv = ["-c"] + sys.argv[3:]',
    'exec(compile(code, "<string>", "exec"), {"__name__": "__main__"})', ''].join('\n'));
  writeFileSync(path.join(project, 'models.py'), 'class Box[T]:\n    pass\n\n\nclass Repository:\n    pass\n');
  writeFileSync(path.join(project, 'plain.py'), 'class PlainThing:\n    pass\n');
  const py311 = `{ ...ide.currentInterp(), args: [...ide.currentInterp().args, ${JSON.stringify(path.join(project, '..', 'py311.py'))}], version: '3.11.0' }`;
  const classesWith = (interp) => t.js(`ide.api.invoke('search:symbolIndex', ${interp}, ide.root, 0).then((r) => r.files.flatMap(([, s]) => s).filter((x) => x.kind === 'class').map((x) => x.name).filter((n) => !n.startsWith('Model')).sort())`);
  const under311 = await classesWith(py311);
  const under314 = await classesWith('ide.currentInterp()');
  const back311 = await classesWith(py311);
  record(under311.join() === 'AddedLater,ChangedWhileClosed,PlainThing' && under314.join() === 'AddedLater,Box,ChangedWhileClosed,PlainThing,Repository'
    && back311.join() === under311.join(),
    `models.py is parsed again when the index is asked with another Python (3.11: ${under311.join(', ')}; current: ${under314.join(', ')}; 3.11 again: ${back311.join(', ')})`);
  const storeText = () => readdirSync(storeDir).filter((n) => n.endsWith('.json')).map((n) => readFileSync(path.join(storeDir, n), 'utf8')).join('');
  for (let i = 0; i < 50 && !/models\.py",[\d.]+,\[\]/.test(storeText()); i++) await t.sleep(100);
  errors.push(...t.consoleErrors);
  t.close();

  // The store now holds the 3.11 parse of models.py (no classes); the current Python reads the file again.
  t = await session(userData);
  const restarted = await gotoClass(t, 'Repos', 'Repository');
  record(restarted.ok, `after a restart Go to Class finds a class that the Python of the stored parse could not read (${restarted.listed.slice(0, 3).join(', ') || 'nothing'})`);
} catch (err) {
  record(false, err.message);
}
errors.push(...t.consoleErrors);
t.close();
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
