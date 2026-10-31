// Content-Security-Policy of the IDE page, in the real window: it refuses inline code, eval and remote scripts, and
// everything the app needs still loads under it (a user plugin's script and style, Monaco's language workers, a trusted
// notebook's HTML output with its scripts, craft mode). Safe Mode: an HTML preview and a notebook output run no script
// and fetch nothing from elsewhere; a page outside a trusted folder has no scripts either. verify/lib.mjs fails any
// suite on a violation of the IDE page's policy, so this one only adds what the others do not open. Ports 9915-9917.
import { createServer } from 'http';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const hits = [];
const server = createServer((req, res) => { hits.push(req.url); res.setHeader('access-control-allow-origin', '*'); res.end('window.__remoteScript = true;'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const remote = `http://127.0.0.1:${server.address().port}`;

const notebook = (html) => S({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'c1', source: ['print(1)'], metadata: {}, execution_count: 1,
  outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/html': [html], 'text/plain': ['x'] } }] }] });
const OUTPUT = '<table id="t"><tr><td>a table</td></tr></table><script>document.body.dataset.ran = "1"; document.body.style.height = "300px";</script>';
const frameOf = `ide.activeTab().host.querySelector('iframe.nb-html')`;
const failures = [];
const report = (t, label) => {
  t.check(!t.cspViolations.length, `no violations of the IDE page's policy in ${label}${t.cspViolations.length ? `: ${t.cspViolations.join(' | ')}` : ''}`);
  t.check(!t.consoleErrors.length, `no renderer exceptions in ${label}${t.consoleErrors.length ? `: ${t.consoleErrors.join(' | ')}` : ''}`);
  failures.push(...t.results.filter((r) => !r.ok));
};

// ---------- code mode ----------
{
  const userData = path.join(tempDir('csp-data'), 'userdata');
  const probe = path.join(userData, 'plugins', 'csp-probe');
  mkdirSync(probe, { recursive: true });
  writeFileSync(path.join(probe, 'plugin.json'), S({ id: 'csp-probe', name: 'CSP Probe', version: '1.0.0', vendor: 'Test', description: 'Loads from the user data folder.' }));
  writeFileSync(path.join(probe, 'index.js'), 'window.__cspProbe = true;\n');
  writeFileSync(path.join(probe, 'style.css'), ':root { --csp-probe: loaded; }\n');
  const t = await launch({ fixture: 'core', port: 9915, name: 'csp', userData });
  const { js, until, check, sleep, cdp } = t;
  try {
    const policy = await js(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''`);
    check(/script-src 'self';/.test(policy) && !policy.includes('unsafe-eval'), `the IDE page has a policy without inline scripts or eval (${policy})`);
    check(!t.cspViolations.length, `the IDE starts without a violation${t.cspViolations.length ? `: ${t.cspViolations.join(' | ')}` : ''}`);
    check(await js(`window.__cspProbe === true && getComputedStyle(document.documentElement).getPropertyValue('--csp-probe').trim() === 'loaded'`), "a user plugin's script and style load from the user data folder");
    check(await js(`document.querySelectorAll('script[data-plugin]').length > 40`), 'the bundled plugins load');

    const refused = async (expression) => (await cdp('Runtime.evaluate', { expression, allowUnsafeEvalBlockedByCSP: false, returnByValue: true })).result?.exceptionDetails?.exception?.className;
    check(await refused(`eval('1 + 1')`) === 'EvalError', 'eval is refused');
    check(await refused(`new Function('return 1')()`) === 'EvalError', 'new Function is refused');
    await js(`(() => {
      const d = document.createElement('div');
      d.innerHTML = '<img src="data:," onerror="window.__inline = 1"><a id="cspLink" href="javascript:window.__inline = 2">x</a>';
      document.body.append(d);
      const s = document.createElement('script');
      s.textContent = 'window.__inline = 3';
      document.body.append(s);
      document.getElementById('cspLink').click();
      window.__injected = d;
      return true;
    })()`);
    await sleep(400);
    check(await js(`window.__inline === undefined`), 'an inline event handler, an inline script and a javascript: link do not run');
    const script = await js(`new Promise((res) => { const s = document.createElement('script'); s.src = ${S(`${remote}/remote.js`)}; s.onload = () => res('loaded'); s.onerror = () => res('refused'); document.body.append(s); })`);
    check(script === 'refused' && !hits.length && await js(`window.__remoteScript === undefined`), 'a remote script is refused before any request');
    await until(`true`, 'violations logged');
    await sleep(200);
    check(t.cspViolations.length >= 3, `the refusals are reported as violations (${t.cspViolations.length}), so a suite sees one`);
    t.cspViolations.length = 0;
    await js(`(window.__injected.remove(), true)`);

    await js(`(() => {
      const Real = window.Worker;
      window.__workers = [];
      window.Worker = function (...a) { const w = new Real(...a); const r = { errors: 0 }; w.addEventListener('error', () => { r.errors++; }); window.__workers.push(r); return w; };
      return true;
    })()`);
    writeFileSync(path.join(t.project, 'probe.ts'), 'const n: number = "text";\n');
    await openFile(t, 'probe.ts');
    await until(`ide.monaco.editor.getModelMarkers({ owner: 'typescript' }).length > 0`, 'TypeScript worker diagnostics', 30000);
    check(await js(`window.__workers.length > 0 && window.__workers.every((w) => !w.errors)`), `Monaco's TypeScript worker runs as a worker and reports the type error (${S(await js('window.__workers'))})`);

    writeFileSync(path.join(t.project, 'out.ipynb'), notebook(OUTPUT));
    await openFile(t, 'out.ipynb');
    await until(`parseInt(${frameOf}?.style.height) >= 300`, "a trusted notebook output's script", 15000)
      .then(() => check(true, "a trusted notebook's HTML output runs its scripts and sizes its frame"), () => check(false, "a trusted notebook's HTML output runs its scripts and sizes its frame"));
    check(await js(`${frameOf}.getAttribute('sandbox') === 'allow-scripts' && (() => { try { return ${frameOf}.contentDocument === null; } catch { return true; } })()`), 'its frame is sandboxed from the IDE');
    await sleep(500);
    check(hits.length === 0, 'nothing reached the test server');
  } catch (err) {
    check(false, err.message);
    await t.shot('failure.png');
  }
  report(t, 'code mode');
  t.close();
}

// ---------- craft mode ----------
{
  const t = await launch({ fixture: 'core', port: 9916, name: 'csp-craft', mode: 'craft', env: { PYIDE_CRAFT_HOME: path.join(tempDir('csp-craft-home'), 'Craft') } });
  try {
    t.check(await t.js(`ide.appMode`) === 'craft', 'craft mode opens');
    await t.sleep(3000);
  } catch (err) {
    t.check(false, err.message);
  }
  report(t, 'craft mode');
  t.close();
}

// ---------- Safe Mode ----------
{
  const work = tempDir('csp-safe');
  const home = path.join(work, 'home');
  const repo = path.join(work, 'downloaded');
  const loose = path.join(work, 'loose');
  for (const d of [home, repo, loose]) mkdirSync(d);
  writeFileSync(path.join(home, 'a.py'), 'x = 1\n');
  const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="${remote}/style.css"><script src="${remote}/script.js"></script></head>
<body><h1>page</h1><img src="${remote}/pixel.png"><img src="own.svg"><script>document.title = 'scripted'; fetch('${remote}/fetch', { method: 'POST', body: 'x', mode: 'no-cors' });</script></body></html>\n`;
  writeFileSync(path.join(repo, 'index.html'), PAGE);
  writeFileSync(path.join(repo, 'own.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n');
  writeFileSync(path.join(repo, 'out.ipynb'), notebook(OUTPUT));
  writeFileSync(path.join(loose, 'page.html'), '<!doctype html><p>loose</p>\n');
  const userData = path.join(work, 'userdata');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'settings.json'), S({ recentProjects: [{ path: home, opened: Date.now() }] }));
  const t = await launch({ fixture: 'core', port: 9917, name: 'csp-safe', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } });
  const { js, until, check, sleep, cdp } = t;
  const off = `ide.activeTab().host.querySelector('.vw-html-scripts-off').textContent`;
  try {
    await js(`ide.openFile(${S(path.join(loose, 'page.html'))})`);
    await until(`${off} !== ''`, 'scripts-off note for a page outside the project');
    check(await js(`ide.activeTab().host.querySelector('.vw-html-frame').getAttribute('sandbox') === ''`), 'a page outside any trusted folder previews without scripts');

    js(`ide.openProject(${S(repo)})`);
    await until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent.includes('Trust and Open Project?'))`, 'trust question');
    await js(`([...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Preview in Safe Mode').click(), true)`);
    await until(`ide.root && ide.util.samePath(ide.root, ${S(repo)}) && ide.trusted === false`, 'opened in Safe Mode', 30000);
    await js(`ide.openFile(${S(path.join(repo, 'index.html'))})`);
    await until(`${off} !== ''`, 'preview in Safe Mode');
    const frame = `ide.activeTab().host.querySelector('.vw-html-frame')`;
    check(await js(`${frame}.getAttribute('sandbox') === ''`), 'Safe Mode: the preview has no allow-scripts');
    await until(`!!${frame}.src`, 'preview loaded');
    await sleep(1500);
    // A sandboxed frame runs in a process of its own, so it is a debug target of its own.
    const target = (await (await fetch('http://127.0.0.1:9917/json')).json()).find((x) => x.url.startsWith('pyide-preview://'));
    check(!!target, `Safe Mode: the page is shown (${target?.type} ${target?.url})`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const read = (expression) => new Promise((r) => {
      const my = ++id;
      const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === my) { ws.removeEventListener('message', on); r(msg.result?.result?.value); } };
      ws.addEventListener('message', on);
      ws.send(S({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    check(await read(`document.querySelector('h1')?.textContent`) === 'page', 'Safe Mode: its HTML renders');
    check(await read(`document.title`) !== 'scripted', 'Safe Mode: its script does not run');
    check(await read(`document.images[1].naturalWidth`) === 4, 'Safe Mode: its own image loads');
    ws.close();
    check(hits.length === 0, `Safe Mode: the page reaches nothing outside its folder (${S(hits)})`);

    await js(`ide.openFile(${S(path.join(repo, 'out.ipynb'))})`);
    await until(`${frameOf}?.contentDocument?.querySelector('#t')`, 'Safe Mode notebook output', 20000);
    await until(`parseInt(${frameOf}.style.height) >= 16`, 'output measured');
    await sleep(500);
    check(await js(`${frameOf}.getAttribute('sandbox') === 'allow-same-origin' && !${frameOf}.contentDocument.body.dataset.ran && parseInt(${frameOf}.style.height) < 300`),
      "Safe Mode: a notebook's HTML output shows without running its script, in a frame that fits it");
  } catch (err) {
    check(false, err.message);
    await t.shot('failure.png');
  }
  report(t, 'Safe Mode');
  t.close();
}

server.close();
console.log(failures.length ? `${failures.length} failed` : 'all passed');
process.exit(failures.length ? 1 : 0);
