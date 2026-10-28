// HTML preview of a JavaScript app (a Create React App project): the built page (build/index.html) loads the files it
// asks for from the server root (/static/js/main.js) out of its own folder, and the template (public/index.html), which
// only the dev server fills in, gets a notice with "Run npm start" (a terminal tab, then the IDE's browser at the address
// the dev server prints) and "Open build/index.html". Port 9795.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-html-preview-app-')), 'project');
const w = (rel, text) => { mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); writeFileSync(path.join(project, rel), text); };
w('package.json', JSON.stringify({ name: 'demo', scripts: { start: 'node dev-server.js', build: 'echo build' }, dependencies: { react: '19.0.0', 'react-scripts': '5.0.1' } }, null, 2));
mkdirSync(path.join(project, 'node_modules'));
w('public/index.html', '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<link rel="icon" href="%PUBLIC_URL%/favicon.ico" />\n<title>Demo</title>\n</head>\n<body>\n<noscript>You need to enable JavaScript to run this app.</noscript>\n<div id="root"></div>\n</body>\n</html>\n');
w('build/index.html', '<!doctype html><html><head><link href="/static/css/main.css" rel="stylesheet"><script defer src="/static/js/main.js"></script></head><body><div id="root"></div></body></html>');
w('build/static/css/main.css', 'body { background: rgb(1, 2, 3); }\n');
w('build/static/js/main.js', `document.getElementById('root').textContent = 'built app';
addEventListener('load', () => parent.postMessage({ pyideTest: 'built', text: document.getElementById('root').textContent, bg: getComputedStyle(document.body).backgroundColor }, '*'));
`);
w('dev-server.js', `const http = require('http');
const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>dev server page</h1>'); });
s.listen(0, '127.0.0.1', () => console.log('Compiled successfully!\\n\\n  Local:            http://localhost:' + s.address().port));
`);

const t = await launch({ name: 'html-preview-app', port: 9795, projectDir: project });
const { js, until, check, sleep } = t;
const S = JSON.stringify;
const active = () => `document.querySelector('.editor-group.active .vw-html') || [...document.querySelectorAll('.vw-html')].find((n) => n.offsetParent)`;
let devId = null;
try {
  await js(`(window.__msgs = [], addEventListener('message', (e) => { if (e.data?.pyideTest) window.__msgs.push(e.data); }), true)`);

  await openFile(t, 'build/index.html');
  await until(`window.__msgs.some((m) => m.pyideTest === 'built')`, 'built page reports', 20000);
  const built = await js(`window.__msgs.find((m) => m.pyideTest === 'built')`);
  check(built.text === 'built app' && built.bg === 'rgb(1, 2, 3)', `the built page's /static/ script and stylesheet load from its own folder (${S(built)})`);
  check(await js(`(${active()}).querySelector('.vw-html-notice').classList.contains('hidden')`), 'a built page gets no notice');

  await openFile(t, 'public/index.html');
  await until(`!(${active()})?.querySelector('.vw-html-notice').classList.contains('hidden')`, 'notice on the template', 15000);
  const text = await js(`(${active()}).querySelector('.vw-html-notice').textContent`);
  check(/template of a react-scripts app/.test(text), `the template explains that its dev server fills it in (${S(text)})`);
  const buttons = await js(`[...(${active()}).querySelectorAll('.vw-html-notice button')].map((b) => b.textContent)`);
  check(buttons[0] === 'Run npm start' && buttons.some((b) => /^Open build.index\.html$/.test(b)), `it offers npm start and the built page (${S(buttons)})`);

  await js(`[...(${active()}).querySelectorAll('.vw-html-notice button')].find((b) => b.textContent.startsWith('Open build')).click()`);
  await until(`ide.activeTab()?.path?.toLowerCase().endsWith('build\\\\index.html')`, 'built page opened');
  check(true, 'Open build/index.html opens the built page');

  await openFile(t, 'public/index.html');
  await until(`!(${active()})?.querySelector('.vw-html-notice').classList.contains('hidden')`, 'notice again', 15000);
  await js(`[...(${active()}).querySelectorAll('.vw-html-notice button')].find((b) => b.textContent === 'Run npm start').click()`);
  await until(`ide.terminal.sessions().some((s) => s.name === 'npm start')`, 'dev server terminal', 15000);
  devId = await js(`ide.terminal.sessions().find((s) => s.name === 'npm start').id`);
  check(true, 'Run npm start starts the script in a terminal tab');
  await until(`!!document.querySelector('.vw-html-notice[data-dev-url]')`, 'dev server address found', 90000);
  const devUrl = await js(`document.querySelector('.vw-html-notice[data-dev-url]').dataset.devUrl`);
  check(/^http:\/\/localhost:\d+$/.test(devUrl), `the address the dev server prints is found (${devUrl})`);
  await until(`ide.frameworks.browser()?.host.dataset.url === ${S(devUrl)} && !!ide.frameworks.browser()?.host.dataset.loaded`, 'browser tab shows the dev server', 20000);
  check(true, "the IDE's browser opens the app at that address");
  await sleep(300);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
if (devId) await js(`(ide.terminal.close(${S(devId)}), true)`).catch(() => {});
await sleep(500);
t.finish();
