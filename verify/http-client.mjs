// HTTP Client: highlighting, ▶ gutter and Ctrl+Enter, environments and switching them, in-file, dynamic and named
// response variables, `< file` bodies, JSON/HTML/image responses, a refused connection, private values in the log
// scrubber, New HTTP Request, the frameworks route action, and the Korean tool window. Two local Node servers stand in
// for the "dev" and "prod" environments (ports 9995 and 9996; nothing listens on 9997). IDE ports 9990-9991.
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'tok-7f2e91c4b8';
const seen = [];
const big = { sent: 0, closed: false };
function server(label, port) {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ server: label, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/api/items/7') return json(200, { id: 7, name: 'seven', server: label });
      if (url.pathname === '/api/items' && req.method === 'POST') return json(201, { created: JSON.parse(body), server: label });
      if (url.pathname === '/login') return json(200, { token: TOKEN });
      if (url.pathname === '/whoami') return json(200, { auth: req.headers.authorization || null });
      if (url.pathname === '/echo') return json(200, { echoed: body });
      if (url.pathname === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><h1 id="t">Hello page</h1>'); }
      // 64 KB chunks for as long as the client reads (up to 512 MB), and 30 MB of binary.
      if (url.pathname === '/endless') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        const chunk = Buffer.alloc(64 * 1024, 'a');
        res.on('close', () => { big.closed = true; });
        const pump = () => {
          while (!res.destroyed && big.sent < 512 * 1024 * 1024) {
            big.sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          if (!res.destroyed) res.end();
        };
        return pump();
      }
      if (url.pathname === '/blob') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(30 * 1024 * 1024, 7)); }
      if (url.pathname === '/logo.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)));
}
const servers = [await server('dev', 9995), await server('prod', 9996)];
const last = () => seen[seen.length - 1];

const ctx = await launch({ fixture: 'http-client', port: 9990 });
const { js, until, press, type, click, check } = ctx;
try {
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'api.http'))`);
  await until(`ide.activeTab()?.path.endsWith('api.http') && ide.editor.getModel()?.getLanguageId() === 'http'`, 'api.http opens as http');
  check(true, '.http files open with the http language');
  check(await js(`ide.fileIconType('api.http') === 'http' && ide.fileIconType('x.rest') === 'http'`), '.http and .rest files have the HTTP file icon');

  // ---------- highlighting ----------
  const tokens = await js(`(() => {
    const lines = ide.editor.getModel().getLinesContent();
    const toks = ide.monaco.editor.tokenize(lines.join('\\n'), 'http');
    const at = (line, text) => { const l = lines.findIndex((x) => x.startsWith(line)); const col = lines[l].indexOf(text); const ts = toks[l]; let t = ts[0]; for (const x of ts) if (x.offset <= col) t = x; return t.type; };
    return {
      sep: at('### Get item', '###'), name: at('# @name item', '@name'), comment: at('// Nothing', 'Nothing'),
      method: at('POST {{base}}', 'POST'), urlVar: at('POST {{base}}', '{{base}}'), header: at('Content-Type: application/json', 'Content-Type'),
      headerVar: at('X-Request-Id', '{{$uuid}}'), fileVar: at('@base', '@base'), key: at('  "name"', '"name"'), str: at('  "name"', '"widget"'),
      num: at('  "count"', '3'), strVar: at('  "stamp"', '{{$timestamp}}'), include: at('< ./payload.json', '<'),
    };
  })()`);
  check(tokens.sep.startsWith('comment') && tokens.comment.startsWith('comment') && tokens.name.startsWith('tag'), `### separators, comments and # @name (${tokens.sep}, ${tokens.comment}, ${tokens.name})`);
  check(tokens.method.startsWith('keyword') && tokens.header.startsWith('attribute.name'), `request line method and header names (${tokens.method}, ${tokens.header})`);
  check([tokens.urlVar, tokens.headerVar, tokens.fileVar, tokens.strVar].every((t) => t.startsWith('variable')), `{{var}} in the URL, headers, @var lines and JSON strings (${tokens.urlVar}, ${tokens.headerVar}, ${tokens.fileVar}, ${tokens.strVar})`);
  check(tokens.key.startsWith('string.key.json') && tokens.str.startsWith('string') && tokens.num.startsWith('number') && tokens.include.startsWith('tag'),
    `JSON body keys, strings, numbers and < file includes (${tokens.key}, ${tokens.str}, ${tokens.num}, ${tokens.include})`);

  // ---------- gutter, environments ----------
  await until(`ide.editor.getModel().getAllDecorations().some((d) => d.options.glyphMarginClassName === 'http-run-gutter') && document.querySelector('.http-run-gutter')`, 'gutter run icons');
  const parsed = await js(`ide.httpClient.parse(ide.editor.getModel().getValue()).requests.map((r) => r.line)`);
  const glyphs = await js(`ide.editor.getModel().getAllDecorations().filter((d) => d.options.glyphMarginClassName === 'http-run-gutter').map((d) => d.range.startLineNumber)`);
  check(parsed.length === 8 && JSON.stringify(parsed) === JSON.stringify(glyphs), `a ▶ gutter icon on each of the 8 requests (${glyphs})`);

  await js(`ide.httpClient.toolWindow().show()`);
  // Colorized bodies render each line as spans with <br>s and non-breaking spaces; read them as the user sees them.
  await js(`window.bodyText = () => (document.querySelector('.http-pane .http-body')?.innerText || '').replace(/\\u00a0/g, ' ')`);
  await until(`document.querySelector('.http-env')?.options.length === 3`, 'environment selector lists dev and prod');
  check(await js(`[...document.querySelector('.http-env').options].map((o) => o.value).join(',') === ',dev,prod'`), 'environments come from http-client.env.json and http-client.private.env.json');
  await js(`(() => { const s = document.querySelector('.http-env'); s.value = 'dev'; s.dispatchEvent(new Event('change')); })()`);
  check(await js(`ide.httpClient.environment() === 'dev'`), 'choosing dev in the selector sets the environment');

  // GET through the gutter icon: {{base}} is an in-file variable built from {{host}} in the env file.
  const lineOf = (prefix) => js(`ide.editor.getModel().getLinesContent().findIndex((l) => l.startsWith(${JSON.stringify(prefix)})) + 1`);
  const runs = () => js(`ide.httpClient.history().length`);
  const waitRun = async (n, label) => until(`ide.httpClient.history().length === ${n} && !ide.httpClient.history()[0].pending`, label);
  await js(`ide.editor.revealLineInCenter(1)`);
  await click('.http-run-gutter');
  await waitRun(1, 'GET through the gutter icon');
  check(last()?.server === 'dev' && last().method === 'GET' && last().path === '/api/items/7' && last().headers.accept === 'application/json',
    `GET reached the dev server at {{host}}/api/items/7 with its header (${JSON.stringify(last() && [last().server, last().path])})`);
  await until(`document.querySelector('.http-status')?.textContent.startsWith('200')`, 'status shown');
  const panel = await js(`({ status: document.querySelector('.http-status').textContent, meta: [...document.querySelectorAll('.http-meta')].map((n) => n.textContent), body: bodyText(), colored: new Set([...document.querySelectorAll('.http-pane .http-body span[class^="mtk"]')].map((s) => s.className)).size >= 3 })`);
  check(panel.status === '200 OK' && /\d+ ms/.test(panel.meta[0]) && /bytes/.test(panel.meta[1]), `the panel shows status, time and size (${panel.status} | ${panel.meta.join(' | ')})`);
  check(panel.body.trimEnd() === JSON.stringify({ id: 7, name: "seven", server: "dev" }, null, 2) && panel.colored, `the JSON body is pretty-printed and highlighted (${JSON.stringify(panel.body)}, ${panel.colored})`);
  await click('.http-tab[data-tab="headers"]');
  check(await js(`[...document.querySelectorAll('.http-h-name')].some((n) => n.textContent === 'content-type')`), 'the Headers tab lists the response headers');
  await click('.http-tab[data-tab="body"]');

  // POST with a JSON body through Ctrl+Enter, the caret inside the block's body.
  await js(`(() => { ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${await lineOf('  "count"')}, column: 3 }); })()`);
  await press('Ctrl+Enter');
  await waitRun(2, 'POST through Ctrl+Enter');
  const post = last();
  let sent = null;
  try { sent = JSON.parse(post.body); } catch {}
  check(post.method === 'POST' && post.path === '/api/items' && post.headers['content-type'] === 'application/json' && sent?.name === 'widget' && sent.count === 3,
    `Ctrl+Enter ran the request under the caret: POST with the JSON body (${post.body.replace(/\s+/g, ' ')})`);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(post.headers['x-request-id'] || ''), `{{$uuid}} became a UUID (${post.headers['x-request-id']})`);
  check(/^\d{10}$/.test(sent?.stamp || '') && Math.abs(Number(sent.stamp) - Date.now() / 1000) < 120, `{{$timestamp}} became the Unix time (${sent?.stamp})`);
  check(post.headers['x-api-key'] === 'priv-key-5c1e9a77d0', '{{apiKey}} comes from http-client.private.env.json');
  await until(`document.querySelector('.http-status')?.textContent === '201 Created'`, 'POST status shown');
  check(await js(`bodyText().includes('"widget"')`), 'the POST response is shown');

  // Switching the environment changes the target.
  await js(`(() => { const s = document.querySelector('.http-env'); s.value = 'prod'; s.dispatchEvent(new Event('change')); })()`);
  await js(`(() => { ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${await lineOf('GET {{base}}/items/7')}, column: 1 }); })()`);
  await press('Ctrl+Enter');
  await waitRun(3, 'GET on prod');
  check(last().server === 'prod' && last().path === '/api/items/7', `after switching to prod the same request reaches the prod server (${last().server})`);
  await until(`bodyText().includes('"prod"')`, 'prod response shown');
  check(await js(`document.querySelector('.http-env-status:not([hidden])')?.textContent.includes('prod')`), 'the status bar shows the environment of .http files');

  // A named request's response field in a later request: {{login.response.body.$.token}} and {{item.response.body.name}}.
  for (const [prefix, n] of [['POST {{host}}/login', 4], ['GET {{host}}/whoami', 5]]) {
    await js(`(() => { ide.editor.focus(); ide.editor.setPosition({ lineNumber: ${await lineOf(prefix)}, column: 1 }); })()`);
    await press('Ctrl+Enter');
    await waitRun(n, prefix);
  }
  check(last().path === '/whoami' && last().headers.authorization === `Bearer ${TOKEN}` && last().query.item === 'seven',
    `named responses feed later requests (Authorization: ${last().headers.authorization}, item=${last().query.item})`);

  // < ./payload.json
  await js(`ide.httpClient.runAtLine(ide.editor, ${await lineOf('POST {{host}}/echo')})`);
  await waitRun(6, 'body from a file');
  check(last().path === '/echo' && last().body === readFileSync(path.join(ctx.project, 'payload.json'), 'utf8'), `< ./payload.json sends the file (${JSON.stringify(last().body)})`);

  // HTML and image responses.
  await js(`ide.httpClient.runAtLine(ide.editor, ${await lineOf('GET {{host}}/page.html')})`);
  await waitRun(7, 'HTML page');
  await until(`document.querySelector('.http-pane[data-kind="html"]') && bodyText().includes('Hello page')`, 'HTML source shown');
  await js(`[...document.querySelectorAll('.http-pane .http-tab')].find((b) => b.textContent === 'Preview').click()`);
  check(await js(`(() => { const f = document.querySelector('.http-pane .http-preview'); return !!f && !f.hidden && f.getAttribute('sandbox') === '' && f.srcdoc.includes('Hello page'); })()`), 'an HTML response has its source and a sandboxed preview');
  await js(`ide.httpClient.runAtLine(ide.editor, ${await lineOf('GET {{host}}/logo.png')})`);
  await waitRun(8, 'image');
  await until(`document.querySelector('.http-pane[data-kind="image"] img.http-image')?.complete`, 'image preview');
  check(await js(`document.querySelector('.http-pane img.http-image').naturalWidth === 1`), 'an image response is previewed');

  // Connection refused.
  await js(`ide.httpClient.runAtLine(ide.editor, ${await lineOf('GET http://127.0.0.1:9997')})`);
  await waitRun(9, 'refused');
  const err = await js(`document.querySelector('.http-error')?.textContent || ''`);
  check(err === 'Connection refused: nothing is listening at 127.0.0.1:9997.', `a refused connection shows a readable message (${err})`);

  // A huge or endless body: only the first 5 MB of text is read, then the download stops; binary is only counted.
  const send = (p) => js(`ide.api.invoke('http-client:send', { file: ide.util.joinPath(ide.root, 'api.http'), root: ide.root, request: { method: 'GET', url: 'http://127.0.0.1:9995${p}', headers: [] } })`);
  const t0 = Date.now();
  const endless = await send('/endless');
  const r = endless.response || {};
  await until('true', 'settle');
  await ctx.sleep(300);
  check(endless.ok && r.truncated && r.text.length === 5 * 1024 * 1024 && big.closed && big.sent < 64 * 1024 * 1024 && Date.now() - t0 < 20000,
    `an endless text body stops at 5 MB and the download is dropped (${Date.now() - t0} ms, server sent ${Math.round(big.sent / 1048576)} MB, closed ${big.closed})`);
  const blob = (await send('/blob')).response || {};
  check(blob.kind === 'binary' && blob.size === 30 * 1024 * 1024 && blob.text === undefined && blob.base64 === undefined, `a binary body is counted, not held (${blob.kind}, ${blob.size} bytes)`);

  // History.
  const rows = await js(`[...document.querySelectorAll('.http-row')].map((r) => r.querySelector('.http-row-status').textContent)`);
  check(rows.length === 9 && rows[0] === '✕' && rows[8] === '200', `the history lists every response, newest first (${rows.join(' ')})`);
  await js(`document.querySelectorAll('.http-row')[7].click()`);
  check(await js(`document.querySelector('.http-status')?.textContent === '201 Created'`), 'clicking a history entry shows that response again');
  await ctx.shot('responses.png');

  // Private values never reach the log: they are registered with the scrubber as soon as they are read.
  await js(`ide.log.info('http-client-test apiKey=priv-key-5c1e9a77d0 inline priv-key-5c1e9a77d0')`);
  const logFile = path.join(ctx.userData, 'logs', 'pyide.log');
  await until(`true`, 'log flush');
  await ctx.sleep(800);
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  check(log.includes('http-client-test') && !log.includes('priv-key-5c1e9a77d0'), 'private environment values are masked in the IDE log');

  // New HTTP Request from the File menu action.
  await js(`void ide.runAction('NewHttpRequest')`);
  await until(`document.activeElement?.id === 'popupIn'`, 'file name prompt');
  await js(`document.getElementById('popupIn').value = ''`);
  await type('scratch');
  await press('Enter');
  await until(`ide.activeTab()?.path.endsWith('scratch.http') && ide.editor.getModel().getLanguageId() === 'http'`, 'new .http file opened');
  check(await js(`ide.httpClient.parse(ide.editor.getModel().getValue()).requests.length === 1`), 'New HTTP Request creates scratch.http with an example request');

  // Many large responses: the history keeps the bodies of the newest only (64 MB of them), the rest their status.
  await js(`(ide.editor.getModel().setValue('GET http://127.0.0.1:9995/endless\\n'), true)`);
  for (let i = 0; i < 14; i++) {
    const n = await js(`ide.httpClient.history().length`);
    await js(`(ide.httpClient.runAtLine(ide.editor, 1), true)`);
    await until(`ide.httpClient.history()[0]?.id && !ide.httpClient.history()[0].pending && ide.httpClient.history().length >= ${Math.min(n + 1, 50)}`, `large response ${i + 1}`, 30000);
  }
  const kept = await js(`(() => { const h = ide.httpClient.history().slice(0, 14).map((e) => e.result.response);
    return { bodies: h.filter((r) => r.text).length, dropped: h.filter((r) => r.bodyDropped && r.text === undefined).length, status: h.every((r) => r.status === 200),
      chars: ide.httpClient.history().reduce((a, e) => a + (e.result?.response?.text?.length || 0) + (e.result?.response?.base64?.length || 0), 0) }; })()`);
  check(kept.bodies === 12 && kept.dropped === 2 && kept.status && kept.chars <= 64 * 1024 * 1024,
    `older responses beyond 64 MB of bodies keep only their status and headers (${JSON.stringify(kept)})`);
  await js(`document.querySelectorAll('.http-row')[13].click()`);
  await js(`(document.querySelector('.http-tab[data-tab="body"]')?.click(), true)`);
  check(await js(`document.querySelector('.http-status')?.textContent.startsWith('200') && document.querySelector('.http-pane')?.textContent.includes('no longer kept')`),
    'an older response without its body says so');

  // Frameworks: the route menu gains "Generate Request in HTTP Client".
  if (await js(`!!ide.frameworks`)) {
    check(await js(`ide.frameworks.routeActions.some((a) => a.title() === 'Generate Request in HTTP Client')`), 'the frameworks route menu has Generate Request in HTTP Client');
    const gen = await js(`ide.httpClient.generateRequest({ framework: 'fastapi', methods: ['POST'], path: '/items/{item_id}', name: 'create', view: 'main.create', file: '', line: 1 })`);
    const text = await js(`ide.editor.getModel().getValue()`);
    check(gen && /generated-requests\.http$/.test(gen.path) && /^### POST \/items\/\{item_id\}\nPOST http:\/\/127\.0\.0\.1:\d+\/items\/1\nContent-Type: application\/json\n\n\{\}\n$/.test(text),
      `a route becomes a request in generated-requests.http (${JSON.stringify(text)})`);
  }
} catch (e) {
  check(false, e.message);
}
ctx.close();

// Korean: the tool window has no English left.
const ko = await launch({ fixture: 'http-client', port: 9991, name: 'http-client-ko', lang: 'ko-KR' });
try {
  await ko.js(`ide.openFile(ide.util.joinPath(ide.root, 'api.http'))`);
  await ko.until(`ide.editor.getModel()?.getLanguageId() === 'http'`, 'api.http (ko)');
  await ko.js(`ide.httpClient.setEnvironment('dev')`);
  await ko.js(`ide.httpClient.runAtLine(ide.editor, 5)`);
  await ko.until(`document.querySelector('.http-status')?.textContent.startsWith('200')`, 'response (ko)');
  const leaks = await englishLeaks(ko, '.http-tool', ['OK', 'dev', 'GET']);
  ko.check(leaks.length === 0, `the HTTP Client tool window is in Korean (${leaks.map((l) => `${l.text} @${l.where}`).join(' | ')})`);
  ko.check(await ko.js(`document.querySelector('[data-tab="body"]').textContent === '본문' && ide.actions.find((a) => a.id === 'NewHttpRequest').title === '새 HTTP 요청'`), 'Korean labels for tabs and actions');
} catch (e) {
  ko.check(false, e.message);
}
for (const s of servers) s.close();
const failedEn = ctx.results.filter((r) => !r.ok).length;
if (ctx.consoleErrors.length) console.log(`renderer exceptions (en):\n  ${ctx.consoleErrors.join('\n  ')}`);
check(ctx.consoleErrors.length === 0, 'no renderer exceptions');
ko.results.push(...ctx.results);
ko.consoleErrors.push(...ctx.consoleErrors);
if (failedEn) console.log(`${failedEn} English checks failed`);
ko.finish();
