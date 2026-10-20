// "ResizeObserver loop completed with undelivered notifications" is a browser notice, not an exception: it must not
// pile up as IDE internal errors (it reached 1764 in one session) and is logged once per window instead. Observers
// made with ide.util.observeSize run their work in the next frame and skip unchanged sizes, so a callback that
// resizes what it watches settles without that notice.
import { readFileSync } from 'fs';
import { launch } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9875, name: 'resize-observer' });
const { js, until, check, cdp, sleep } = t;
// The window may sit behind others; rendering (and with it ResizeObserver) only runs when frames are produced.
const frames = setInterval(() => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 }).catch(() => {}), 16);
try {
  await js(`(window.__ro = 0, addEventListener('error', (e) => { if (/ResizeObserver loop/.test(e.message)) window.__ro++; }), true)`);
  const errorsBefore = (await js(`ide.api.invoke('diagnostics:errors')`)).length;

  // A raw observer that grows its own element 40 times: the browser reports the loop notice.
  await js(`(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:4px;opacity:0'; document.body.appendChild(d); let n = 0; const ro = new ResizeObserver(() => { if (n++ < 40) d.style.width = (10 + n) + 'px'; else ro.disconnect(); }); ro.observe(d); return true; })()`);
  await until(`window.__ro >= 10`, 'raw loop notices', 10000);
  await sleep(500);
  const errors = await js(`ide.api.invoke('diagnostics:errors')`);
  check(errors.length === errorsBefore && !errors.some((e) => /ResizeObserver loop/.test(e.message)), `the loop notice is not an internal error (${await js('window.__ro')} notices)`);
  const log = readFileSync(await js(`ide.api.invoke('diagnostics:logFile')`), 'utf8');
  const lines = log.split('\n').filter((l) => /ResizeObserver loop/.test(l));
  check(lines.length === 1 && /WARN/.test(lines[0]) && /logged once per window/.test(lines[0]), `it is logged once, as a warning (${lines.length} log lines)`);

  // The same self-resizing callback through observeSize settles without any notice.
  const before = await js('window.__ro');
  await js(`(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:10px;width:10px;height:4px;opacity:0'; document.body.appendChild(d); window.__calls = 0; const o = ide.util.observeSize(d, () => { if (++window.__calls < 40) d.style.width = (10 + window.__calls) + 'px'; else o.disconnect(); }); return true; })()`);
  await until(`window.__calls >= 40`, 'observeSize settles', 10000);
  check((await js('window.__ro')) === before, 'a callback that resizes its own element through observeSize raises no loop notice');
  const size = await js(`(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:20px;width:10px;height:4px;opacity:0'; document.body.appendChild(d); window.__hits = 0; ide.util.observeSize(d, () => window.__hits++); return new Promise((r) => setTimeout(() => { d.style.width = '10px'; setTimeout(() => { const same = window.__hits; d.style.width = '30px'; setTimeout(() => r({ first: same, after: window.__hits }), 200); }, 200); }, 200)); })()`);
  check(size.first === 1 && size.after === 2, `observeSize calls once for the first size, skips an unchanged size and calls again on a change (${JSON.stringify(size)})`);
  check(t.consoleErrors.length === 0 || t.consoleErrors.every((e) => /ResizeObserver loop/.test(e)), 'no other renderer exceptions');
} catch (err) {
  check(false, err.message);
}
clearInterval(frames);
t.finish();
