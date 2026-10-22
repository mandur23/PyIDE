// Idle unloading of the local AI models: the setting in Settings › AI › AI Completion (fake backends), then, when both
// real models are installed, the sidecars stopping after the idle time without an internal error, the process tree's
// working set before and after, and the reload on the next request with the status-bar loading hint.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { descendants, launch, openFile, processSnapshot } from './lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const IDLE = 0.05; // minutes: three seconds

// Working set of a process and its descendants, in MB, by image name, and how many Python sidecars the IDE runs
// (its direct python.exe children: a venv launcher may run the interpreter as a child of its own).
function treeMemory(rootPid) {
  const tree = descendants(processSnapshot(), rootPid, { includeRoot: true });
  const byName = {};
  for (const p of tree) byName[p.name] = Math.round((byName[p.name] || 0) + p.workingSet / 1048576);
  return { totalMB: Math.round(tree.reduce((s, p) => s + p.workingSet, 0) / 1048576), python: tree.filter((p) => p.name === 'python.exe' && p.ppid === rootPid).length, byName };
}
const states = (t) => t.js(`({ complete: ide.aiComplete.status()?.engine?.state, semantic: ide.semantic.status()?.model?.state })`);
// Polls the two status-bar items and records every text they show, so a hint that lasts seconds is not missed.
const watchStatus = (t) => t.js(`(() => {
  window.__seen = new Set();
  const note = () => { for (const id of ['semanticStatus', 'aiCompleteStatus']) { const s = document.getElementById(id)?.textContent; if (s) window.__seen.add(s); } };
  clearInterval(window.__watch);
  window.__watch = setInterval(note, 100);
  return true;
})()`);
const seen = (t) => t.js(`[...window.__seen]`);

let a;
let b;
let c;
try {
  // ---------- the setting (fake backends) ----------
  a = await launch({ fixture: 'ai-complete', port: 9822, name: 'ai-idle' });
  await a.js(`ide.runAction('AICompletionSettings')`);
  await a.until(`!!document.querySelector('#aicIdle')`, 'settings dialog');
  check(await a.js(`document.querySelector('#aicIdle').value === '10' && document.querySelector('#aicIdle').min === '0'`), 'Settings › AI › AI Completion offers the idle unload time, 10 minutes by default');
  await a.js(`(() => { const n = document.querySelector('#aicIdle'); n.value = '25'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await a.click('.dialog-buttons .primary');
  check(await a.js(`ide.settings.get('ai.idleUnloadMinutes') === 25`), 'the idle time is saved as ai.idleUnloadMinutes');
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
  a.close();

  // ---------- the real sidecars ----------
  b = await launch({ fixture: 'semantic', port: 9823, name: 'ai-idle-real', env: { PYIDE_SEMANTIC_BACKEND: 'real', PYIDE_AI_COMPLETE_BACKEND: 'real' } });
  const rs = await b.js(`(async () => ({ s: await ide.api.invoke('semantic:status'), c: await ide.api.invoke('ai-complete:status') }))()`);
  const installed = rs.s.runtime && rs.s.downloaded && rs.c.runtime && rs.c.models.some((m) => m.installed);
  if (!installed) {
    console.log(`SKIP real sidecars (EmbeddingGemma 2 ${rs.s.runtime && rs.s.downloaded ? 'installed' : 'missing'}, Qwen2.5-Coder ${rs.c.models.some((m) => m.installed) ? 'installed' : 'missing'})`);
  } else {
    // Never unload while both models load; the idle time is set once they are warm, which has to reach the servers.
    await b.js(`(ide.settings.set('ai.idleUnloadMinutes', 0), true)`);
    await watchStatus(b);
    await b.until(`ide.semantic.status()?.model?.state === 'ready' && (await ide.api.invoke('semantic:indexInfo', ide.root)).files === 5 && !(await ide.api.invoke('semantic:indexInfo', ide.root)).indexing`, 'index with the real model', 600000);
    await openFile(b, 'utils/strings.py');
    const first = await b.js(`ide.api.invoke('ai-complete:complete', { id: 'idle-1', prefix: 'def add(a, b):\\n    ', suffix: '\\n', path: 'x.py', language: 'python', context: [], multiline: true, model: 'qwen2.5-coder-0.5b', repo: 'project' })`);
    await b.until(`ide.aiComplete.status()?.engine?.state === 'ready'`, 'completion model ready', 120000);
    check(/return/.test(first.text || ''), `both models answered (completion ${JSON.stringify(first.text)})`);
    const warm = treeMemory(b.pid);
    check(warm.python === 2, `two Python sidecars run while the models are warm (${JSON.stringify(warm.byName)})`);

    await b.js(`(ide.settings.set('ai.idleUnloadMinutes', ${IDLE}), true)`);
    const t0 = Date.now();
    await b.until(`ide.aiComplete.status()?.engine?.state === 'idle' && ide.semantic.status()?.model?.state === 'idle'`, 'both unloaded', 60000);
    const unloadMs = Date.now() - t0;
    await b.sleep(1500);
    const cold = treeMemory(b.pid);
    console.log(`working set warm ${warm.totalMB} MB ${JSON.stringify(warm.byName)} -> after unload ${cold.totalMB} MB ${JSON.stringify(cold.byName)} (unloaded ${unloadMs} ms after the last reply)`);
    check(cold.python === 0 && cold.totalMB < warm.totalMB - 1000, `the sidecars exit ${IDLE * 60} s after their last request and free their memory (${warm.totalMB} -> ${cold.totalMB} MB)`);
    const errors = await b.js(`ide.api.invoke('diagnostics:errors')`);
    check(errors.length === 0, `an idle exit is not an internal error${errors.length ? ` ${JSON.stringify(errors.map((e) => e.message))}` : ''}`);
    check(await b.js(`!document.querySelector('#semanticStatus').textContent && ide.aiComplete.mode() === 'on'`), 'the status bar shows nothing special while a model is unloaded');

    // Reload on demand: a semantic query and a completion start their servers again. Back to "never unload" first:
    // the completion answers seconds before the embedding model has loaded, and would go idle again meanwhile.
    await b.js(`(ide.settings.set('ai.idleUnloadMinutes', 0), window.__seen.clear(), true)`);
    const [hits, second] = await b.js(`Promise.all([
      ide.semantic.query('reconnect websocket backoff'),
      ide.api.invoke('ai-complete:complete', { id: 'idle-2', prefix: 'def area(w, h):\\n    ', suffix: '\\n', path: 'x.py', language: 'python', context: [], multiline: true, model: 'qwen2.5-coder-0.5b', repo: 'project' }),
    ])`);
    check(hits[0]?.rel.endsWith('reconnect.py') && /return/.test(second.text || ''), `the next requests reload the models and are answered (${hits[0]?.rel}, ${JSON.stringify(second.text)})`);
    const shown = await seen(b);
    check(shown.some((s) => /Loading EmbeddingGemma/.test(s)) && shown.some((s) => /loading/.test(s)), `the status bar showed the loading hints meanwhile (${JSON.stringify(shown)})`);
    const back = { ...(await treeMemory(b.pid)), ...(await states(b)) };
    check(back.python === 2 && back.complete === 'ready' && back.semantic === 'ready', `both sidecars are back and ready (${JSON.stringify(back)})`);
    await b.sleep(IDLE * 60000 + 2000);
    const kept = { ...(await treeMemory(b.pid)), ...(await states(b)) };
    check(kept.python === 2, `0 keeps the models loaded past the earlier idle time (${JSON.stringify(kept)})`);
    check((await b.js(`ide.api.invoke('diagnostics:errors').then((e) => e.length)`)) === 0 && b.consoleErrors.length === 0, 'no internal or renderer errors');
  }
  b.close();

  // ---------- a model that fails to load ----------
  // Broken model files in an otherwise empty cache: each server reports the failure, and the status bar shows the
  // error instead of keeping its loading hint up.
  if (rs.s.runtime && rs.c.runtime) {
    const cache = mkdtempSync(path.join(tmpdir(), 'pyide-broken-hf-'));
    for (const [repo, file] of [['google/embeddinggemma-2', 'model.safetensors'], ['ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF', 'qwen2.5-coder-0.5b-q8_0.gguf']]) {
      const dir = path.join(cache, `models--${repo.replace('/', '--')}`, 'snapshots', 'broken');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, file), 'not a model');
    }
    c = await launch({ fixture: 'semantic', port: 9824, name: 'ai-idle-broken', env: { PYIDE_SEMANTIC_BACKEND: 'real', PYIDE_AI_COMPLETE_BACKEND: 'real', HF_HUB_CACHE: cache, HF_HUB_OFFLINE: '1' } });
    await watchStatus(c);
    const [query, completion] = await c.js(`Promise.all([
      ide.api.invoke('semantic:query', ide.root, 'anything', {}),
      ide.api.invoke('ai-complete:complete', { id: 'broken-1', prefix: 'def f():\\n    ', suffix: '\\n', path: 'x.py', language: 'python', context: [], multiline: true, model: 'qwen2.5-coder-0.5b', repo: 'project' }),
    ])`);
    await c.sleep(500);
    const st = await states(c);
    const bar = await c.js(`({ semantic: document.querySelector('#semanticStatus').textContent, complete: document.querySelector('#aiCompleteStatus').textContent })`);
    check(!query.ok && completion.error && st.semantic === 'error' && st.complete === 'error' && !/Loading|loading/.test(bar.semantic + bar.complete),
      `a model that fails to load ends its loading state (${JSON.stringify({ st, bar, query: query.error?.slice(0, 80), completion: completion.error?.slice(0, 80) })})`);
    c.close();
  }
} catch (err) {
  check(false, err.message);
  a?.close();
  b?.close();
  c?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
