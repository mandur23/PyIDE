// Semantic search plugin: indexing, popup and tool window search, incremental updates, find similar code,
// persistence, the setup screen, and Korean UI. Uses the deterministic test backend unless SEMANTIC_REAL=1
// (then it runs against the installed EmbeddingGemma 2 and also checks a Korean natural-language query).
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const REAL = process.env.SEMANTIC_REAL === '1';
process.env.PYIDE_SEMANTIC_BACKEND = REAL ? 'real' : 'fake';
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const top = (t) => t.js(`[...document.querySelectorAll('#semanticResults .sem-row')].map(r => r.dataset.rel.replace(/\\\\/g, '/'))`);

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
  await openFile(a, 'utils/strings.py');
  await a.js(`(() => { const m = ide.editor.getModel(); m.applyEdits([{ range: new ide.monaco.Range(m.getLineCount() + 1, 1, m.getLineCount() + 1, 1), text: '\\n\\ndef compute_crc32_checksum(data):\\n    import zlib\\n    return zlib.crc32(data)\\n' }]); })()`);
  await a.press('Ctrl+S');
  await a.until(`ide.semantic.query('${REAL ? 'calculate a checksum of bytes' : 'crc32 checksum'}').then(r => r[0]?.symbol === 'def compute_crc32_checksum')`, 'new function searchable', 60000);
  check(true, 'a saved edit is re-indexed and searchable');

  // ---------- find similar ----------
  await a.js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 2, 60)), true)`);
  await a.js(`ide.runAction('FindSimilarCode')`);
  await a.until(`document.querySelectorAll('#semanticResults .sem-row').length > 0 && ide.toolWindows.get('SemanticSearch').isVisible()`, 'similar results', 30000);
  const similar = await top(a);
  check(similar[0] === 'utils/strings.py', `Find Similar Code lists the selected function first (${similar.slice(0, 3).join(', ')})`);
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
  a.close();

  // ---------- persisted index ----------
  const b = await launch({ fixture: 'semantic', port: 9531, name: 'semantic-reopen', userData: a.userData });
  // launch() copies the fixture to a new folder, so read the first instance's project index, persisted under the shared userData.
  const first = await b.js(`ide.api.invoke('semantic:indexInfo', ${JSON.stringify(a.project)})`);
  check(first.chunks >= 8, `the index is loaded from disk on reopen (${first.chunks} chunks before any re-embedding)`);
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
