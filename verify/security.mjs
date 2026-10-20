// Untrusted content cannot take over the IDE window: the window never leaves the IDE page (links, image maps,
// popups, location changes), only the IDE page gets the IPC API, a README cannot smuggle a link past the Markdown
// sanitizer, dialog text is never markup, the HTML preview server keeps to its folder (encoded "..", hidden files,
// a junction out of the project), and pages get no camera, location or notification permission.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const PORT = 9870;
const t = await launch({ fixture: 'core', port: PORT, name: 'security' });
const { js, until, check, cdp, sleep } = t;
const H = 'ide.activeTab().host';
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((p) => p.type === 'page').length;
const ideAlive = () => js(`typeof ide === 'object' && window.__ideReady === true && /\\/renderer\\/index\\.html$/.test(location.pathname) && typeof window.api?.invoke === 'function'`);

try {
  const w = (rel, data) => { mkdirSync(path.dirname(path.join(t.project, rel)), { recursive: true }); writeFileSync(path.join(t.project, rel), data); };
  w('pic.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  w('other.md', '# Other\n');
  w('README.md', `# Hostile README

<img src="pic.png" usemap="#m" width="300" height="120" alt="map">
<map name="m"><area shape="rect" coords="0,0,300,120" href="other.md"></map>

<svg width="120" height="30"><a><animate attributeName="href" values="javascript:window.__pwned=1"/><text x="2" y="20">svg link</text></a></svg>

[plain link](other.md)
`);
  w('site/index.html', '<!doctype html><title>x</title><p>site</p>\n');
  w('site/probe.html', `<!doctype html><script>
fetch('/' + decodeURIComponent(location.hash.slice(1))).then((r) => r.status, () => 'blocked').then((status) => parent.postMessage({ secProbe: true, status }, '*'));
</script>\n`);
  w('site/.env', 'SECRET=1\n');
  w('site/.hidden/page.html', '<!doctype html><p>hidden page</p>\n');
  const outside = mkdtempSync(path.join(tmpdir(), 'pyide-security-outside-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'outside the project\n');
  symlinkSync(outside, path.join(t.project, 'site', 'escape'), 'junction');

  check(await ideAlive(), 'the IDE page has the IPC API');
  const startPages = await pages();

  // ---------- Markdown preview ----------
  await openFile(t, 'README.md');
  await until(`${H}.querySelector('.vw-md-preview img[usemap]')?.naturalWidth === 1`, 'markdown preview with the image map', 15000);
  check(await js(`!${H}.querySelector('.vw-md-preview animate, .vw-md-preview set') && !!${H}.querySelector('.vw-md-preview svg text')`), 'SVG animations that could rewrite a link are removed from the Markdown preview');
  await t.click('.vw-md-preview img[usemap]');
  await until(`ide.activeTab()?.path?.toLowerCase().endsWith('other.md')`, 'image map link opens in the IDE', 5000)
    .then(() => check(true, "a click on an image map's <area> opens the linked file in the IDE"), () => check(false, "a click on an image map's <area> opens the linked file in the IDE"));
  check(await ideAlive(), 'the image map link did not navigate the IDE window');

  // Middle-click on a link would open a new window (with the IDE's preload) unless window opening is refused.
  await openFile(t, 'README.md');
  await until(`[...${H}.querySelectorAll('.vw-md-preview a')].some((a) => a.textContent === 'plain link')`, 'plain link');
  const box = await js(`(() => { const r = [...${H}.querySelectorAll('.vw-md-preview a')].find((a) => a.textContent === 'plain link').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'middle', clickCount: 1 });
  await sleep(1500);
  check(await pages() === startPages, 'a middle-clicked link opens no new window');

  // ---------- windows and navigation ----------
  check(await js(`window.open('file:///C:/Windows/win.ini') === null`), 'window.open of a file URL is refused');
  await js(`(setTimeout(() => { location.href = 'file:///C:/Windows/win.ini'; }, 0), true)`);
  await sleep(1500);
  check(await ideAlive(), 'the IDE page cannot be navigated to another file');
  check(await pages() === startPages, 'no window was opened by window.open or a navigation');

  // ---------- dialogs ----------
  await js(`(ide.ui.dialog({ title: 'x', body: '<img src="nope.png" onerror="window.__pwned = 1">' }), true)`);
  check(await js(`(() => { const b = [...document.querySelectorAll('.dialog-body')].at(-1); return !b.querySelector('img') && b.textContent.startsWith('<img'); })()`), 'a dialog shows a string body as text, not markup');
  await js(`(document.querySelectorAll('.dialog-buttons .primary').forEach((b) => b.click()), true)`);

  // ---------- HTML preview server ----------
  const site = await js(`ide.api.invoke('viewers:previewUrl', ide.util.joinPath(ide.root, 'site\\\\index.html'), ide.root).then((r) => r.url.replace(/site\\/index\\.html$/, ''))`);
  // The requests come from a page of the site, in a sandboxed frame like the preview's (pyide-preview:// is not
  // fetchable from the IDE page itself).
  const status = (rel) => js(`new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.display = 'none';
    const done = (v) => { removeEventListener('message', on); f.remove(); resolve(v); };
    const on = (e) => { if (e.source === f.contentWindow && e.data?.secProbe) done(e.data.status); };
    addEventListener('message', on);
    f.src = ${JSON.stringify(site)} + 'site/probe.html#' + encodeURIComponent(${JSON.stringify(rel)});
    document.body.appendChild(f);
    setTimeout(() => done('timeout'), 8000);
  })`);
  check(await status('site/index.html') === 200, 'the preview server serves a project file');
  check([403, 404, 'blocked'].includes(await status('..%2F..%2F..%2FWindows%2Fwin.ini')), 'an encoded ".." does not leave the project');
  check([403, 404, 'blocked'].includes(await status('%2e%2e/%2e%2e/%2e%2e/Windows/win.ini')), 'an encoded "." segment does not leave the project');
  check(await status('site/.env') === 404, 'hidden files (.env) are not served');
  check(await status('site/escape/secret.txt') === 403, 'a junction inside the project does not lead out of it');
  await js(`ide.api.invoke('viewers:previewUrl', ide.util.joinPath(ide.root, 'site\\\\.hidden\\\\page.html'), ide.root)`);
  check(await status('site/.hidden/page.html') === 200, 'a previewed page inside a hidden folder is still served');

  // ---------- network shares ----------
  // Fetching a file URL on a share makes Windows sign in to that server (NTLM over SMB). One nobody opened, as in a
  // docstring image, is not fetched: every spelling fails at once instead of after the ~20 s SMB timeout.
  const forms = ['file://10.255.255.11/share/a.png', 'file:////10.255.255.12/share/b.png', 'file:///\\\\10.255.255.13\\share\\c.png', '//10.255.255.14/share/d.png', '\\\\10.255.255.15\\share\\e.png'];
  const loads = await js(`Promise.all(${JSON.stringify(forms)}.map((u) => new Promise((res) => { const i = new Image(); const t0 = performance.now(); i.onload = () => res('loaded'); i.onerror = () => res(Math.round(performance.now() - t0)); i.src = u; })))`);
  check(loads.every((ms) => typeof ms === 'number' && ms < 2000), `images on a network share nobody opened are not fetched (failed after ${loads.join(', ')} ms)`);
  await openFile(t, 'hello.py');
  await js(`(window.__shareHover = ide.monaco.languages.registerHoverProvider('python', { provideHover: () => ({ contents: [{ value: 'Docstring ![x](file://10.255.255.16/share/h.png)' }] }) }), true)`);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 2 }), ide.editor.trigger('verify', 'editor.action.showHover', {}), true)`);
  await until(`!!document.querySelector('.monaco-hover img[src^="file://10.255.255.16"]')`, 'hover with a docstring image on a share', 10000);
  const settled = await until(`document.querySelector('.monaco-hover img[src^="file://10.255.255.16"]').complete`, 'hover image settled', 3000).then(() => true, () => false);
  check(settled, 'a docstring image on a network share in a Monaco hover is not fetched');
  await js(`(window.__shareHover.dispose(), true)`);

  // ---------- permissions ----------
  check(await js(`navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)`) === 'denied', 'location access is denied');
  check(await js(`Notification.permission`) === 'denied', 'notifications are denied');
  check(await js(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name)`) !== 'granted', 'the microphone is denied');
  check(await js(`window.__pwned === undefined`), 'no injected script ran');

  // ---------- the API belongs to the IDE page only ----------
  // A browser-initiated load (DevTools) is the only way to put another page in the window; it must not get the API.
  w('elsewhere.html', '<!doctype html><p>not the IDE</p>\n');
  await cdp('Page.navigate', { url: `file:///${path.join(t.project, 'elsewhere.html').split(path.sep).join('/')}` });
  await until(`document.body?.textContent.includes('not the IDE')`, 'other page loaded', 10000);
  check(await js(`typeof window.api`) === 'undefined', 'a page other than the IDE gets no IPC API');
} catch (err) {
  check(false, err.message);
}
t.finish();
