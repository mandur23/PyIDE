// Semantic search plugin: indexing, popup and tool window search, incremental updates, the index log on disk
// (appended per change, flushed at quit), find similar code, persistence, the setup screen, and Korean UI. Uses the
// deterministic test backend unless SEMANTIC_REAL=1 (then it runs against the installed EmbeddingGemma 2 and also
// checks a Korean natural-language query).
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const REAL = process.env.SEMANTIC_REAL === '1';
process.env.PYIDE_SEMANTIC_BACKEND = REAL ? 'real' : 'fake';
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const top = (t) => t.js(`[...document.querySelectorAll('#semanticResults .sem-row')].map(r => r.dataset.rel.replace(/\\\\/g, '/'))`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The project's index log under userData (main/features/semantic.js keyOf).
const indexLog = (t) => path.join(t.userData, 'semantic', 'indexes', createHash('sha1').update(t.project.toLowerCase()).digest('hex').slice(0, 16), 'index.jsonl');
const appendToStrings = (t, code) => t.js(`(() => { const m = ide.editor.getModel(); m.applyEdits([{ range: new ide.monaco.Range(m.getLineCount() + 1, 1, m.getLineCount() + 1, 1), text: ${JSON.stringify(code)} }]); })()`);

// ---------- the index log (main/features/semantic.js), without the IDE ----------
{
  const t = createRequire(import.meta.url)('../main/features/semantic.js')._test;
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'pyide-semantic-log-'));
  const dir = tmp();
  const vec = (seed) => Float32Array.from({ length: 256 }, (_, i) => (seed * 1000 + i) / 1e6);
  const file = (seed) => ({ mtime: seed, size: seed, chunks: [{ start: 0, end: 2, symbol: `def f${seed}`, title: 'x.py', text: `def f${seed}():\n    return ${seed}`, vector: vec(seed) }] });
  const lines = (d) => readFileSync(path.join(d, 'index.jsonl'), 'utf8').trim().split('\n');
  const reread = async (d) => { const r = t.newIndex('C:\\proj', d, 'fake'); await t.readIndex(r); return r; };
  const sameVector = (idx, rel, seed) => idx.files[rel] && [...idx.files[rel].chunks[0].vector].every((x, i) => Math.abs(x - vec(seed)[i]) < 1e-9);
  const rowsOnDisk = (idx) => statSync(path.join(idx.dir, idx.vectors)).size / 1024;
  const filesOf = (idx) => Object.keys(idx.files).sort().join();

  const idx = t.newIndex('C:\\proj', dir, 'fake');
  t.remember(idx, 'a.py', file(1));
  t.remember(idx, 'b.py', file(2));
  await t.flush(idx);
  t.forget(idx, 'a.py');
  t.remember(idx, 'b.py', file(3));
  t.remember(idx, 'c.py', file(4));
  await t.flush(idx);
  const log = lines(dir);
  check(log.length === 6 && JSON.parse(log[0]).version === 3 && JSON.parse(log[3])[1] === null && JSON.parse(log[5])[0] === 'c.py', `changes are appended to the log as records and tombstones (${log.length - 1} records for 3 files)`);
  const back = await reread(dir);
  check(filesOf(back) === 'b.py,c.py' && sameVector(back, 'b.py', 3) && sameVector(back, 'c.py', 4) && back.records === 5 && rowsOnDisk(back) === 4,
    'reading the log replays it: the last record per file wins, a tombstone removes the file, vectors come back by row');
  t.remember(back, 'd.py', file(5));
  await t.compact(back);
  const compacted = await reread(dir);
  const names = readdirSync(dir);
  check(lines(dir).length === 4 && names.filter((n) => n.startsWith('vectors-')).length === 1 && names.includes(compacted.vectors) && rowsOnDisk(compacted) === 3
    && filesOf(compacted) === 'b.py,c.py,d.py' && sameVector(compacted, 'b.py', 3) && sameVector(compacted, 'd.py', 5),
    'compaction rewrites the log with one record per live file into a new vector file and drops the old one');
  const dir2 = tmp();
  const q = t.newIndex('C:\\proj', dir2, 'fake');
  t.remember(q, 'x.py', file(9));
  t.flushSync(q);
  check(sameVector(await reread(dir2), 'x.py', 9), 'the synchronous flush used at quit writes a readable log on its own');
  truncateSync(path.join(dir2, q.vectors), 0);
  check(Object.keys((await reread(dir2)).files).length === 0, 'a record whose vectors are missing is dropped, so the file is embedded again');

  const projA = tmp();
  const projB = tmp();
  writeFileSync(path.join(projA, 'a.py'), 'def a():\n    return 1\n');
  writeFileSync(path.join(projB, 'b.py'), 'def b():\n    return 2\n');
  t.collect(projA, [], null);
  t.collect(projB, [], null);
  const pageA = t.take(projA, 200);
  const pageB = t.take(projB, 200);
  check(pageA.length === 1 && pageA[0].f.rel === 'a.py' && pageB.length === 1 && pageB[0].f.rel === 'b.py' && t.take(projA, 200).length === 0,
    'two projects collected at once each take only their own files');

  const dir3 = tmp();
  const w = t.newIndex('C:\\proj', dir3, 'fake');
  t.remember(w, 'a.py', file(1));
  t.remember(w, 'b.py', file(2));
  await t.flush(w);
  chmodSync(path.join(dir3, 'index.jsonl'), 0o444);
  t.remember(w, 'c.py', file(3));
  const failed = await t.flush(w).then(() => false, () => true);
  chmodSync(path.join(dir3, 'index.jsonl'), 0o644);
  await t.flush(w);
  const retried = await reread(dir3);
  check(failed && filesOf(retried) === 'a.py,b.py,c.py' && sameVector(retried, 'a.py', 1) && sameVector(retried, 'c.py', 3) && rowsOnDisk(retried) === 3 && readdirSync(dir3).filter((n) => n.startsWith('vectors-')).length === 1,
    'a save whose record append fails is written by the next save, and every record then points at its own vectors');

  const dir4 = tmp();
  writeFileSync(path.join(dir4, 'index.jsonl'), `${JSON.stringify({ version: 2, backend: 'fake', dim: 256, root: 'C:\\proj', vectors: 'vectors-old.bin' })}\n["old.py",{"mtime":1,"size":1,"chunks":[]}]\n`);
  writeFileSync(path.join(dir4, 'vectors-old.bin'), Buffer.alloc(1024));
  const stale = await reread(dir4);
  const staleFiles = Object.keys(stale.files).length;
  t.remember(stale, 'x.py', file(7));
  await t.flush(stale);
  const replaced = lines(dir4);
  check(staleFiles === 0 && replaced.length === 2 && JSON.parse(replaced[0]).version === 3 && JSON.parse(replaced[1])[0] === 'x.py'
    && !readdirSync(dir4).includes('vectors-old.bin') && sameVector(await reread(dir4), 'x.py', 7),
    'a log from another index version is replaced by the next save, not appended to');
  const dir5 = tmp();
  let robust = true;
  for (const content of ['', 'null\n', '{"version":3,"backend":"fake"']) {
    writeFileSync(path.join(dir5, 'index.jsonl'), content);
    const r = t.newIndex('C:\\proj', dir5, 'fake');
    robust &&= await t.readIndex(r).then(() => Object.keys(r.files).length === 0, () => false);
    t.remember(r, 'y.py', file(8));
    t.flushSync(r);
    robust &&= lines(dir5).length === 2 && JSON.parse(lines(dir5)[0]).version === 3 && sameVector(await reread(dir5), 'y.py', 8);
  }
  check(robust, 'an empty, null or cut-short header line is read as no index and replaced by the save at quit');

  const dir6 = tmp();
  const u = t.newIndex('C:\\proj', dir6, 'fake');
  t.remember(u, 'a.py', file(1));
  t.remember(u, 'b.py', file(2));
  await t.flush(u);
  truncateSync(path.join(dir6, u.vectors), 2048 + 100);
  const tail = await reread(dir6);
  t.remember(tail, 'c.py', file(3));
  await t.flush(tail);
  const aligned = await reread(dir6);
  check(lines(dir6).length === 4 && rowsOnDisk(aligned) === 3 && filesOf(aligned) === 'a.py,b.py,c.py' && sameVector(aligned, 'b.py', 2) && sameVector(aligned, 'c.py', 3),
    'part of a row a crash left at the end of the vector file is cut off and the next save appends on the row boundary');
  truncateSync(path.join(dir6, aligned.vectors), 1024 + 100);
  const cut = await reread(dir6);
  const cutFiles = filesOf(cut);
  t.remember(cut, 'd.py', file(4));
  await t.flush(cut);
  const rewritten = await reread(dir6);
  check(cutFiles === 'a.py' && rowsOnDisk(rewritten) === 2 && filesOf(rewritten) === 'a.py,d.py' && sameVector(rewritten, 'a.py', 1) && sameVector(rewritten, 'd.py', 4),
    'records whose rows the cut took are dropped, and the next save rewrites the log so no later row can stand in for them');

  const dir7 = tmp();
  const y = t.newIndex('C:\\proj', dir7, 'fake');
  t.remember(y, 'a.py', file(1));
  t.remember(y, 'b.py', file(2));
  const inFlight = t.flush(y);
  t.remember(y, 'c.py', file(3));
  t.flushSync(y);
  await inFlight;
  await sleep(50);
  const quit = await reread(dir7);
  check(filesOf(quit) === 'a.py,b.py,c.py' && sameVector(quit, 'a.py', 1) && sameVector(quit, 'b.py', 2) && sameVector(quit, 'c.py', 3) && rowsOnDisk(quit) === 3 && quit.records === 3,
    'the save at quit during a save in flight writes the later changes after it, every record on its own row');

  // ---------- what is indexed: Git-ignored paths, virtual environments anywhere, data folders, exclusions ----------
  const repo = tmp();
  const put = (rel, text = 'def f():\n    return 1\n') => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
  put('.gitignore', 'data/\nmodels/\n*.log.txt\n');
  for (const rel of ['src/app.py', 'data/train.py', 'models/m.py', 'tools/nested/.venv-rvc/lib.py', 'envs/py311/lib.py', 'pkg/core.py', 'docs/guide.md']) put(rel);
  put('src/run.log.txt', 'epoch 1\n');
  put('tools/nested/.venv-rvc/pyvenv.cfg', 'home = C:\\Python311\n');
  put('envs/py311/conda-meta/history', '');
  for (let i = 0; i < 1100; i++) put(`datasets/rec${i}.json`, '{"a": 1}\n');
  for (let i = 0; i < 1100; i++) put(`pkg/fixtures/f${i}.json`, '{"b": 2}\n');
  const relsOf = (w) => w.files.map((f) => f.rel.replace(/\\/g, '/')).sort().join();
  const reasonsOf = (w) => Object.fromEntries(w.skipped.map((s) => [s.rel.replace(/\\/g, '/'), s.reason]));
  const plain = t.walk(repo, { ignored: t.gitIgnored(repo) });
  check(t.gitIgnored(repo).size === 0, 'a folder that is not a Git repository has nothing ignored');
  execSync('git init -q', { cwd: repo });
  const ignored = t.gitIgnored(repo);
  const w1 = t.walk(repo, { ignored });
  const r1 = reasonsOf(w1);
  check(relsOf(w1) === 'docs/guide.md,pkg/core.py,src/app.py' && r1.data === 'ignored' && r1.models === 'ignored',
    `folders and files Git ignores are not indexed (${relsOf(w1)})`);
  check(r1['tools/nested/.venv-rvc'] === 'venv' && r1['envs/py311'] === 'venv', 'virtual environments are skipped at any depth (pyvenv.cfg, conda-meta)');
  check(r1.datasets === 'data' && r1['pkg/fixtures'] === 'data' && relsOf(w1).includes('pkg/core.py'),
    'folders of mostly data over the file limit are skipped, and a package keeps its code next to a large fixtures folder');
  check(relsOf(plain).includes('data/train.py') && relsOf(plain).includes('models/m.py') && relsOf(plain).includes('src/run.log.txt'),
    'without Git the same project indexes those folders as before');
  const w2 = t.walk(repo, { ignored, dataFiles: 5000, excluded: ['src'] });
  check(relsOf(w2).includes('datasets/rec7.json') && !relsOf(w2).includes('src/app.py') && reasonsOf(w2).src === 'excluded',
    'the data folder limit is a setting, and excluded folders are left out');
}

let a;
try {
  a = await launch({ fixture: 'semantic', port: 9530, name: 'semantic' });
  await a.until(`ide.semantic.status()?.runtime && (await ide.api.invoke('semantic:indexInfo', ide.root)).files === 5 && document.querySelector('#semanticStatus').classList.contains('hidden')`, 'index ready', REAL ? 600000 : 30000);
  const info = await a.js(`ide.api.invoke('semantic:indexInfo', ide.root)`);
  check(info.files === 5 && info.chunks >= 8, `project indexed into code-aware chunks (${info.files} files, ${info.chunks} chunks)`);
  const venvHit = await a.js(`ide.semantic.query('connect_with_backoff_in_venv').then(r => r.some(x => x.rel.includes('.venv')))`);
  check(!venvHit, 'virtual environments are not indexed');

  // ---------- popup ----------
  await openFile(a, 'utils/strings.py');
  await a.press('Ctrl+Alt+F');
  await a.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'semantic popup');
  await a.type(REAL ? 'retry the socket connection with exponential delay' : 'reconnect websocket backoff');
  await a.until(`document.querySelector('.popup-item.active')?.textContent.includes('connect_with_backoff')`, 'top popup hit', 30000);
  check(true, 'Ctrl+Alt+F popup finds the reconnect function by description');
  await a.press('Enter');
  await a.until(`ide.activeTab()?.title === 'reconnect.py' && ide.editor.getPosition().lineNumber === 5`, 'opened at the function');
  check(true, 'choosing a result opens the file at the function');

  // ---------- tool window ----------
  await a.js(`ide.toolWindows.get('SemanticSearch').show()`);
  await a.until(`document.activeElement?.id === 'semanticInput'`, 'input focused');
  await a.type(REAL ? 'detect when an elderly person falls down' : 'fall pose landmarks');
  await a.until(`document.querySelectorAll('#semanticResults .sem-row').length > 0`, 'results', 30000);
  const hits = await top(a);
  check(hits[0] === 'vision/pose.py', `tool window ranks the fall detector first (${hits.slice(0, 3).join(', ')})`);
  check(await a.js(`!!document.querySelector('.sem-preview-code')?.textContent.includes('FallDetector') || !!document.querySelector('.sem-preview-code')?.textContent.includes('is_fall')`), 'the selected result shows a colorized preview');
  await a.shot('tool-window.png');
  if (REAL) {
    await a.js(`(() => { const i = document.querySelector('#semanticInput'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await a.type('텍스트를 음성 파일로 바꾸는 함수');
    await a.until(`[...document.querySelectorAll('#semanticResults .sem-row')][0]?.dataset.rel.endsWith('tts.py')`, 'Korean query', 30000);
    check(true, 'a Korean description finds the English text-to-speech code');
  }

  // ---------- incremental update ----------
  await sleep(2500);
  const logBefore = readFileSync(indexLog(a), 'utf8');
  check(logBefore.split('\n').length === 7 && JSON.parse(logBefore.split('\n')[0]).version === 3, `the index log holds a header and one record per file (${logBefore.split('\n').length - 2} records)`);
  await openFile(a, 'utils/strings.py');
  await appendToStrings(a, '\n\ndef compute_crc32_checksum(data):\n    import zlib\n    return zlib.crc32(data)\n');
  await a.press('Ctrl+S');
  await a.until(`ide.semantic.query('${REAL ? 'calculate a checksum of bytes' : 'crc32 checksum'}').then(r => r[0]?.symbol === 'def compute_crc32_checksum')`, 'new function searchable', 60000);
  check(true, 'a saved edit is re-indexed and searchable');
  await sleep(3000);
  const logAfter = readFileSync(indexLog(a), 'utf8');
  const added = logAfter.slice(logBefore.length).split('\n').filter(Boolean);
  check(logAfter.startsWith(logBefore) && added.length === 1 && added[0].includes('compute_crc32_checksum') && JSON.parse(added[0])[0].endsWith('strings.py'),
    `a save appends one record for the file to the index log instead of rewriting it (${added.length} record added)`);

  // ---------- find similar ----------
  await a.js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 2, 60)), true)`);
  await a.js(`ide.runAction('FindSimilarCode')`);
  await a.until(`document.querySelectorAll('#semanticResults .sem-row').length > 0 && ide.toolWindows.get('SemanticSearch').isVisible()`, 'similar results', 30000);
  const similar = await top(a);
  check(similar[0] === 'utils/strings.py', `Find Similar Code lists the selected function first (${similar.slice(0, 3).join(', ')})`);
  check(a.consoleErrors.length === 0, 'no renderer exceptions');

  // ---------- flush at quit ----------
  // A change indexed right before the IDE quits has not reached the log yet (it waits a couple of seconds); quitting
  // through the window, as the user does, writes it.
  await openFile(a, 'utils/strings.py');
  await appendToStrings(a, '\n\ndef quit_flush_marker():\n    return 1\n');
  await a.press('Ctrl+S');
  await a.until(`ide.semantic.query('${REAL ? 'quit flush marker' : 'quit flush marker'}').then(r => r.some(x => x.symbol === 'def quit_flush_marker'))`, 'marker indexed', 60000);
  await a.js(`(window.close(), true)`);
  for (let i = 0; i < 100; i++) { try { process.kill(a.pid, 0); await sleep(200); } catch { break; } }
  const logQuit = readFileSync(indexLog(a), 'utf8');
  check(logQuit.includes('quit_flush_marker') && logQuit.startsWith(logAfter), 'quitting the IDE writes the pending index changes before it exits');
  a.close();

  // ---------- persisted index ----------
  const b = await launch({ fixture: 'semantic', port: 9531, name: 'semantic-reopen', userData: a.userData });
  // launch() copies the fixture to a new folder, so read the first instance's project index, persisted under the shared userData.
  const first = await b.js(`ide.api.invoke('semantic:indexInfo', ${JSON.stringify(a.project)})`);
  check(first.chunks >= 8, `the index is loaded from disk on reopen (${first.chunks} chunks before any re-embedding)`);
  check(await b.js(`ide.api.invoke('semantic:query', ${JSON.stringify(a.project)}, 'quit flush marker', {}).then(r => r.results.some(x => x.symbol === 'def quit_flush_marker'))`), 'the change flushed at quit is searchable after reopening');
  b.close();

  // ---------- setup screen ----------
  if (!REAL) {
    process.env.PYIDE_SEMANTIC_BACKEND = 'real';
    const c = await launch({ fixture: 'semantic', port: 9532, name: 'semantic-setup', lang: 'ko-KR' });
    await c.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
    const st = await c.js(`ide.api.invoke('semantic:status')`);
    if (!st.runtime) {
      await c.js(`ide.toolWindows.get('SemanticSearch').show()`);
      await c.until(`!document.querySelector('.sem-setup').classList.contains('hidden')`, 'setup box');
      check(await c.js(`document.querySelector('#semanticStatus').textContent.includes('설정 필요') || document.querySelector('#semanticStatus').textContent.includes('setup needed')`), 'without the model the status bar says setup is needed');
      check(await c.js(`document.querySelector('#semanticInput').disabled`), 'search stays disabled until setup');
      await c.shot('setup.png');
    } else check(true, 'EmbeddingGemma 2 already set up on this machine (setup screen skipped)');
    c.close();
    const d = await launch({ fixture: 'semantic', port: 9533, name: 'semantic-ko', lang: 'ko-KR', userData: a.userData });
    await d.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
    d.close();
    process.env.PYIDE_SEMANTIC_BACKEND = 'fake';
    const e = await launch({ fixture: 'semantic', port: 9534, name: 'semantic-ko2', lang: 'ko-KR', userData: a.userData });
    await e.js(`ide.toolWindows.get('SemanticSearch').show()`);
    await e.type('fall pose');
    await e.until(`document.querySelectorAll('#semanticResults .sem-row').length > 0`, 'ko results');
    const leaks = await englishLeaks(e, '.sem-tool, #semanticStatus', ['EmbeddingGemma', 'CPU', 'GPU', 'CUDA']);
    check(!leaks.length, `Semantic Search UI is in Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
    await e.shot('korean.png');
    e.close();
  }
} catch (err) {
  check(false, err.message);
  a?.close();
}

// ---------- a large Git project: ignored folders, saves during the run and resume, pause, typing, exclusion, size prompt ----------
// The test backend takes PYIDE_SEMANTIC_FAKE_PAGE_MS per page of 200 files, so the run lasts long enough to pause and
// kill part-way. With SEMANTIC_REAL=1 only the ignored folder and the embedding server's thread cap are checked.
const sem = createRequire(import.meta.url)('../main/features/semantic.js')._test;
function makeProject(generated, ignoredFiles) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyide-semantic-git-'));
  cpSync(fileURLToPath(new URL('./fixtures/semantic', import.meta.url)), dir, { recursive: true });
  writeFileSync(path.join(dir, '.gitignore'), 'data/\n');
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  for (let i = 0; i < generated; i++) put(`gen/g${i % 10}/m${i}.py`, `def generated_helper_${i}(x):\n    return x + ${i}\n`);
  for (let i = 0; i < ignoredFiles; i++) put(`data/d${i}.py`, `def ignored_dataset_marker_${i}():\n    return ${i}\n`);
  execSync('git init -q', { cwd: dir });
  return dir;
}
const records = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1) : []);
const rowOf = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === ${JSON.stringify(name)})`;
async function treeMenu(t, name) {
  await t.until(`!!${rowOf(name)}`, `tree row ${name}`);
  await t.js(`(() => { const n = ${rowOf(name)}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await t.until(`!!document.querySelector('.context-menu')`, 'tree context menu');
  return t.js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);
}
const clickMenu = (t, label) => t.js(`[...document.querySelectorAll('.context-menu .menu-label')].find((l) => l.textContent === ${JSON.stringify(label)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
const progressOf = (t) => t.js('ide.semantic.progress()');
const infoOf = (t) => t.js(`ide.api.invoke('semantic:indexInfo', ide.root)`);
const seeded = (settings) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyide-semantic-ud-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};

const live = [];
try {
  const proj = makeProject(REAL ? 0 : 2000, REAL ? 20 : 300);
  const plan = sem.collect(proj, [], null, {});
  sem.take(proj, 1e9);
  const files = plan.files;
  const env = { PYIDE_SEMANTIC_FAKE_PAGE_MS: '1500' };
  const big = await launch({ projectDir: proj, port: 9535, name: 'semantic-git', env });
  live.push(big);
  if (REAL) {
    await big.until(`ide.semantic.progress()?.phase === 'ready' && ide.semantic.progress().files === ${files}`, 'index ready', 600000);
    check(!(await big.js(`ide.semantic.query('ignored dataset marker').then((r) => r.some((x) => x.rel.startsWith('data')))`)) && plan.skipped.some((s) => s.rel === 'data' && s.reason === 'ignored'),
      `the Git-ignored data folder is not indexed (${(await infoOf(big)).files} files)`);
    const st = await big.js(`ide.api.invoke('semantic:status')`);
    check(st.model.threads >= 1 && st.model.threads <= Math.ceil((await import('os')).cpus().length / 2), `the embedding server runs on ${st.model.threads} torch threads`);
  } else {
    await big.until(`ide.semantic.progress()?.phase === 'indexing' && ide.semantic.progress().done > 0`, 'indexing started', 30000);
    const first = await progressOf(big);
    check(first.total === plan.chunks && plan.skipped.some((s) => s.rel === 'data' && s.reason === 'ignored'),
      `the Git-ignored data folder is not embedded (${first.total} chunks in the run, ${plan.chunks} expected)`);
    await big.until(`/Semantic index \\d+% · .+ left/.test(document.querySelector('#semanticStatus').textContent)`, 'progress with time left', 10000);
    check(true, `the status bar shows progress and the time left ("${await big.js(`document.querySelector('#semanticStatus').textContent`)}")`);

    // Pause from the tool window, resume from the project tree.
    await big.js(`ide.toolWindows.get('SemanticSearch').show()`);
    await big.until(`!!document.querySelector('button[title="Pause Indexing"]')`, 'pause button');
    await big.js(`document.querySelector('button[title="Pause Indexing"]').click()`);
    await big.until(`ide.semantic.progress().paused && document.querySelector('#semanticStatus').textContent.includes('paused')`, 'paused status');
    await sleep(2000); // the page in flight finishes
    const atPause = (await progressOf(big)).done;
    await sleep(4000);
    check((await progressOf(big)).done === atPause && await big.js(`!!document.querySelector('button[title="Resume Indexing"]')`),
      `Pause Indexing in the tool window holds the run (${atPause}/${first.total} for 4 s)`);
    const menu = await treeMenu(big, 'gen');
    await big.shot('paused.png');
    check(menu.includes('Resume Semantic Indexing') && menu.includes('Exclude from Semantic Index'), 'the project tree offers Resume and Exclude from Semantic Index');
    await clickMenu(big, 'Resume Semantic Indexing');
    await big.until(`!ide.semantic.progress().paused && ide.semantic.progress().done > ${atPause}`, 'resumed', 15000);
    check(true, 'Resume from the project tree continues the run');

    // Typing holds the run too.
    await openFile(big, 'utils/strings.py');
    const typing = big.js(`(async () => { const m = ide.editor.getModel(); for (let i = 0; i < 25; i++) { m.applyEdits([{ range: new ide.monaco.Range(1, 1, 1, 1), text: '#' }]); await new Promise((r) => setTimeout(r, 200)); } return true; })()`);
    await sleep(2500);
    const midTyping = (await progressOf(big)).done;
    await typing;
    const afterTyping = (await progressOf(big)).done;
    check(afterTyping === midTyping && (await progressOf(big)).phase === 'indexing', `indexing waits while the user types (${midTyping}/${first.total} through 2.5 s of typing)`);

    // Killed after a save during the run: the next launch embeds only the rest.
    for (let i = 0; i < 300 && records(indexLog(big)).length < 800; i++) await sleep(100);
    const killedAt = await progressOf(big);
    const saved = records(indexLog(big));
    big.close();
    const savedChunks = saved.reduce((n, l) => { try { return n + (JSON.parse(l)[1]?.chunks.length || 0); } catch { return n; } }, 0);
    check(killedAt.phase === 'indexing' && saved.length >= 800 && saved.length < files,
      `the index is saved during the run (${saved.length} of ${files} files on disk when the app was killed at ${killedAt.done}/${killedAt.total} chunks)`);
    await sleep(1000);
    const again = await launch({ projectDir: proj, port: 9536, name: 'semantic-git-2', env, userData: big.userData });
    live.push(again);
    await again.until(`ide.semantic.progress()?.phase === 'ready' && ide.semantic.progress().files === ${files}`, 'resumed run done', 60000);
    const rest = await progressOf(again);
    check(rest.total >= plan.chunks - savedChunks && rest.total <= plan.chunks - savedChunks + 200,
      `after a restart only the rest is embedded (${rest.total} of ${plan.chunks} chunks; ${savedChunks} came from disk)`);
    check(!(await again.js(`ide.semantic.query('ignored dataset marker').then((r) => r.some((x) => x.rel.startsWith('data')))`)), 'nothing from the ignored folder is found');

    // Exclude and include again from the project tree.
    await treeMenu(again, 'gen');
    await clickMenu(again, 'Exclude from Semantic Index');
    await again.until(`ide.api.invoke('semantic:indexInfo', ide.root).then((i) => !i.indexing && i.files === ${files - 2000})`, 'gen excluded', 30000);
    const exclusions = JSON.parse(readFileSync(path.join(again.userData, 'semantic', 'exclusions.json'), 'utf8'));
    check(!(await again.js(`ide.semantic.query('generated helper').then((r) => r.some((x) => x.rel.startsWith('gen')))`)) && Object.values(exclusions).some((l) => l.includes('gen')),
      'Exclude from Semantic Index drops the folder from the index and remembers it');
    const menu2 = await treeMenu(again, 'gen');
    await clickMenu(again, 'Include in Semantic Index');
    await again.until(`ide.semantic.progress()?.phase === 'indexing' && ide.semantic.progress().total === 2000`, 'gen indexed again', 15000);
    check(menu2.includes('Include in Semantic Index') && !menu2.includes('Exclude from Semantic Index'), 'an excluded folder offers Include in Semantic Index, which indexes it again');
    again.close();

    // A first index over the threshold asks first: untick a folder and Index, or Not Now and Index Now later.
    const ask = await launch({ projectDir: proj, port: 9537, name: 'semantic-ask', userData: seeded({ 'semantic.confirmChunks': 100 }) });
    live.push(ask);
    await ask.until(`!!document.querySelector('#semanticConfirm')`, 'size prompt', 30000);
    const prompt = await ask.js(`document.querySelector('#semanticConfirm').textContent`);
    check(prompt.includes(`${files} files`) && prompt.includes(`${plan.chunks} chunks`) && await ask.js(`!!document.querySelector('#semanticConfirm input[data-rel="gen"]')`),
      'a first index over the threshold shows its files and chunks and the largest folders before it starts');
    check((await infoOf(ask)).files === 0 && (await progressOf(ask)).phase === 'confirm', 'nothing is embedded while the question is open');
    await ask.shot('size-prompt.png');
    await ask.js(`(document.querySelector('#semanticConfirm input[data-rel="gen"]').click(), document.querySelector('#semanticConfirm .dialog-buttons .primary').click(), true)`);
    await ask.until(`ide.api.invoke('semantic:indexInfo', ide.root).then((i) => !i.indexing && i.files === ${files - 2000} && i.excluded.includes('gen'))`, 'indexed without gen', 30000);
    check(true, 'Index with a folder unticked indexes the project without it');
    ask.close();
    const no = await launch({ projectDir: proj, port: 9538, name: 'semantic-ask-2', userData: seeded({ 'semantic.confirmChunks': 100 }) });
    live.push(no);
    await no.until(`!!document.querySelector('#semanticConfirm')`, 'size prompt', 30000);
    await no.js(`(document.querySelector('#semanticConfirm .dialog-buttons .secondary').click(), true)`);
    await no.js(`ide.toolWindows.get('SemanticSearch').show()`);
    await no.until(`ide.semantic.progress()?.phase === 'declined' && !document.querySelector('.sem-notice').classList.contains('hidden')`, 'declined notice');
    check((await infoOf(no)).files === 0, 'Not Now leaves the project unindexed and says so in the tool window');
    await no.js(`(document.querySelector('#semanticIndexNow').click(), true)`);
    await no.until(`ide.api.invoke('semantic:indexInfo', ide.root).then((i) => !i.indexing && i.files === ${files})`, 'Index Now', 60000);
    check(true, 'Index Now indexes it');
    for (const t of live) check(t.consoleErrors.length === 0, `no renderer exceptions (${t.outDir.split(/[\\/]/).pop()})`);
  }
} catch (err) {
  check(false, err.message);
}
for (const t of live) t.close();

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
