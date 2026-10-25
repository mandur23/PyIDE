// A folder with case sensitivity turned on (fsutil file setCaseSensitiveInfo <dir> enable): a.py and A.py there are two
// documents with their own tabs, saves and shared edits in a second window, while elsewhere names that differ only in
// case still open one document. Port 9413.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const PORT = 9413;
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-case-'));
const project = path.join(work, 'proj');
const cs = path.join(project, 'cs');
const ci = path.join(project, 'ci');
for (const d of [cs, ci]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(project, 'hello.py'), 'print("hello")\n');
let sensitive = true;
try {
  execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', cs, 'enable'], { stdio: 'pipe' });
} catch (err) {
  sensitive = false;
  console.log(`SKIP case-sensitive folder checks: fsutil could not turn case sensitivity on (${String(err.stderr || err.message).trim().slice(0, 200)})`);
}
const lower = path.join(cs, 'a.py');
const upper = path.join(cs, 'A.py');
if (sensitive) {
  writeFileSync(lower, 'LOWER = 1\n');
  writeFileSync(upper, 'UPPER = 2\n');
}
writeFileSync(path.join(ci, 'b.py'), 'B = 1\n');

async function attach(predicate) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && predicate(x.url));
  }
  if (!page) throw new Error('detached window not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  const wjs = async (expr) => {
    const r = await new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } })); });
    if (r.result?.exceptionDetails) throw new Error(`detached: ${expr}\n=> ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  return { js: wjs, close: () => ws.close() };
}

const t = await launch({ fixture: 'core', port: PORT, name: 'case-sensitive', projectDir: project });
const { js, until, check, sleep } = t;
const doc = (p) => `ide.getDocument(${q(p)})`;
const append = (p, s) => `(() => { const m = ${doc(p)}.model; const l = m.getLineCount(); m.pushEditOperations([], [{ range: new ide.monaco.Range(l, 1, l, 1), text: ${q(s)} }], () => null); return true; })()`;
let w;
try {
  if (sensitive) {
    await js(`ide.openFile(${q(lower)})`);
    await js(`ide.openFile(${q(upper)})`);
    const tabs = await js(`ide.tabs.filter((t) => t.kind === 'file' && /[\\\\/]cs[\\\\/]a\\.py$/i.test(t.path)).map((t) => [t.path.slice(-4), t.model.getValue()])`);
    check(tabs.length === 2 && tabs.some(([n, v]) => n === 'a.py' && v === 'LOWER = 1\n') && tabs.some(([n, v]) => n === 'A.py' && v === 'UPPER = 2\n'),
      `a.py and A.py in a case-sensitive folder open as two tabs with their own text (${q(tabs)})`);
    check(await js(`${doc(lower)} !== ${doc(upper)} && !ide.util.samePath(${q(lower)}, ${q(upper)}) && ide.util.samePath(${q(upper)}, ${q(upper)})`),
      'they are two documents, and samePath tells them apart');
    check(await js(`ide.util.samePath(${q(path.join(ci, 'b.py'))}, ${q(path.join(ci, 'B.PY'))}) && ide.util.samePath(${q(lower)}, ${q(lower.replace(/proj/, 'PROJ'))})`),
      'names in folders without case sensitivity still compare without case, also above the case-sensitive folder');
    await js(append(lower, 'EDITED = 3\n'));
    await js(`ide.saveTab(ide.findTab(${q(lower)}))`);
    await sleep(500);
    check(readFileSync(lower, 'utf8') === 'LOWER = 1\nEDITED = 3\n' && readFileSync(upper, 'utf8') === 'UPPER = 2\n' && !(await js(`ide.isDirty(ide.findTab(${q(upper)}))`)),
      'saving a.py writes a.py only and leaves A.py unmodified');

    await js(`ide.api.invoke('window:openDetached', { files: ${q([{ path: lower }, { path: upper }])} })`);
    w = await attach((url) => url.includes('detached=1'));
    for (let i = 0; i < 60 && !(await w.js(`window.__ideReady === true && ide.tabs.length >= 2`).catch(() => false)); i++) await sleep(250);
    await sleep(800);
    await w.js(append(upper, 'FROM_DETACHED = 4\n'));
    await until(`${doc(upper)}.model.getValue().includes('FROM_DETACHED')`, 'main gets the edit of A.py', 8000).catch(() => {});
    const [mainLower, mainUpper, detLower] = [await js(`${doc(lower)}.model.getValue()`), await js(`${doc(upper)}.model.getValue()`), await w.js(`${doc(lower)}.model.getValue()`)];
    check(mainUpper === 'UPPER = 2\nFROM_DETACHED = 4\n' && mainLower === 'LOWER = 1\nEDITED = 3\n' && detLower === mainLower,
      `an edit of A.py in a second window reaches A.py only (${q([mainLower, mainUpper, detLower])})`);
    w.close();
  }
  const bLower = path.join(ci, 'b.py');
  await js(`ide.openFile(${q(bLower)})`);
  await js(`ide.openFile(${q(path.join(ci, 'B.PY'))})`);
  const bTabs = await js(`ide.tabs.filter((t) => t.kind === 'file' && /[\\\\/]ci[\\\\/]b\\.py$/i.test(t.path)).length`);
  check(bTabs === 1, `b.py and B.PY in an ordinary folder open as one document (${bTabs} tabs)`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.close();
await sleep(1000);
try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {}
t.finish();
