// Installs the real EmbeddingGemma 2 runtime and model through the IDE's own setup path (private venv,
// sentence-transformers, ~1.4 GB model download). Run once before `SEMANTIC_REAL=1 node verify/semantic.mjs`.
import { launch } from './lib.mjs';

delete process.env.PYIDE_SEMANTIC_BACKEND;
const t = await launch({ fixture: 'semantic', port: 9540, name: 'semantic-setup-real' });
await t.js(`(window.__semLog = [], ide.api.on('semantic:log', (s) => window.__semLog.push(s)), true)`);
const started = Date.now();
const done = t.js(`ide.api.invoke('semantic:setup', { interpreter: ide.currentInterp()?.executable })`);
let printed = 0;
const timer = setInterval(async () => {
  try {
    const lines = await t.js(`window.__semLog.splice(0).join('')`);
    const tail = lines.split(/\r?\n/).map((l) => l.split('\r').pop()).filter(Boolean);
    for (const l of tail.slice(-3)) console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${l.slice(0, 160)}`);
    printed += tail.length;
  } catch {}
}, 15000);
const r = await done;
clearInterval(timer);
console.log('setup result:', JSON.stringify(r));
console.log('status:', JSON.stringify(await t.js(`ide.api.invoke('semantic:status')`)));
t.close();
process.exit(r.ok ? 0 : 1);
