// Semantic search plugin: indexing, popup and tool window search, incremental updates, the index log on disk
// (appended per change, flushed at quit), find similar code, persistence, the setup screen, and Korean UI. Uses the
// deterministic test backend unless SEMANTIC_REAL=1 (then it runs against the installed EmbeddingGemma 2 and also
// checks a Korean natural-language query).
import { createHash } from 'crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
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
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
