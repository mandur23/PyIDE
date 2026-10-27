// HTML preview: an .html file opens with editor and preview side by side; linked stylesheets (relative and
// root-relative), scripts and images load from the project; unsaved edits to the page or to an open stylesheet show
// at once; script errors are counted; the preview width can be fixed; the page cannot reach the IDE or files outside
// the project. The fixture page reports what it sees with postMessage (its frame is cross-origin to the IDE).
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

function writeSite(project) {
  const w = (rel, text) => { mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); writeFileSync(path.join(project, rel), text); };
  w('site/index.html', `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo</title>
<link rel="stylesheet" href="css/style.css">
<link rel="stylesheet" href="/assets/base.css">
</head><body>
<h1 id="title">Hello preview</h1>
<img id="logo" src="img/logo.svg" alt="logo">
<script src="js/app.js"></script>
</body></html>
`);
  w('site/css/style.css', 'h1 { color: rgb(200, 30, 30); }\n');
  w('assets/base.css', 'body { margin: 7px; }\n');
  w('site/img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>\n');
  w('site/js/app.js', `addEventListener('load', async () => {
  const status = async (u) => { try { return (await fetch(u)).status; } catch { return 'blocked'; } };
  const served = { outside: await status('/..%2F..%2Foutside.txt'), inside: await status('/site/css/style.css') };
  let reachedParent = true;
  try { void parent.document.title; } catch { reachedParent = false; }
  const img = document.getElementById('logo');
  parent.postMessage({ probe: true, title: document.getElementById('title').textContent, h1: getComputedStyle(document.getElementById('title')).color,
    margin: getComputedStyle(document.body).marginTop, img: img.complete && img.naturalWidth === 40, reachedParent, served }, '*');
});
`);
}

const t = await launch({ fixture: 'core', port: 9850, name: 'html-preview' });
const { js, until, check, shot } = t;
try {
  writeSite(t.project);
  await js(`(window.__probes = [], addEventListener('message', (e) => { if (e.data?.probe) window.__probes.push(e.data); }), true)`);
  const probe = () => js(`window.__probes.at(-1) || null`);
  const nextProbe = async (label, ms = 15000) => {
    const n = await js(`window.__probes.length`);
    await until(`window.__probes.length > ${n}`, label, ms);
    return probe();
  };
  const html = path.join(t.project, 'site', 'index.html');
  const first = js(`window.__probes.length`);
  await openFile(t, 'site/index.html');
  await until(`!!document.querySelector('.vw-html .vw-html-frame')`, 'HTML viewer');
  await until(`window.__probes.length > 0`, 'page loaded in the preview', 20000);
  void first;
  const p1 = await probe();
  check(await js(`document.querySelector('.vw-html').dataset.mode === 'split' && !document.querySelector('.vw-html .vw-md-editor').classList.contains('hidden')`), 'an .html file opens with editor and preview side by side');
  check(p1.h1 === 'rgb(200, 30, 30)', `a relative stylesheet (css/style.css) is applied (${p1.h1})`);
  check(p1.margin === '7px', `a root-relative stylesheet (/assets/base.css) is applied (${p1.margin})`);
  check(p1.img === true, 'relative images load');
  check(p1.title === 'Hello preview', 'the page script runs');
  check(p1.reachedParent === false, 'the page cannot reach the IDE window');
  await shot('split.png');

  // Unsaved edits: the page itself, then a stylesheet open in another tab.
  await js(`(() => { const m = document.querySelector('.vw-html')._viewer.editor.getModel(); const r = m.findMatches('Hello preview', false, false, true, null, false)[0].range; m.applyEdits([{ range: r, text: 'Edited live' }]); return true; })()`);
  const p2 = await nextProbe('reload after editing the page');
  check(p2.title === 'Edited live', 'typing in the HTML updates the preview without saving');
  await openFile(t, 'site/css/style.css');
  await js(`(() => { const m = ide.editor.getModel(); m.setValue('h1 { color: rgb(10, 120, 40); }\\n'); return true; })()`);
  const p3 = await nextProbe('reload after editing the stylesheet');
  check(p3.h1 === 'rgb(10, 120, 40)' && await js(`ide.isDirty(ide.activeTab())`), `an unsaved stylesheet change shows in the preview (${p3.h1})`);
  await js(`ide.openFile(${JSON.stringify(html)})`);
  check(await js(`ide.groups()[0].tabs.filter((x) => x.title === 'index.html').length`) === 1, 'opening the page again returns to its tab instead of adding a second one');

  // A preview of another site (a page outside the project) keeps its own unsaved files: this site's stay.
  const other = path.join(t.project, '..', 'other-site', 'page.html');
  mkdirSync(path.dirname(other), { recursive: true });
  writeFileSync(other, `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
addEventListener('load', () => parent.postMessage({ probe: true, title: 'other site' }, '*'));
</script></body></html>\n`);
  await js(`ide.openFile(${JSON.stringify(other)})`);
  check((await nextProbe('preview of another site')).title === 'other site', 'a page outside the project previews from its own folder');
  // The stylesheet is changed again without saving (switching tabs would save it), then both previews reload at
  // once: the other site's (empty) set of unsaved files reaches the server while this page loads its stylesheet.
  await js(`(ide.settings.set('autosave.onTabSwitch', false), ide.settings.set('autosave.onIdle', false), true)`);
  const before4 = await js(`window.__probes.length`);
  await js(`(ide.groups().flatMap((g) => g.tabs).find((x) => x.title === 'style.css').doc.model.setValue('h1 { color: rgb(0, 0, 200); }\\n'), true)`);
  await until(`window.__probes.slice(${before4}).some((p) => p.h1 === 'rgb(0, 0, 200)')`, 'unsaved stylesheet in the page', 15000);
  const before5 = await js(`window.__probes.length`);
  await js(`(() => { const v = [...document.querySelectorAll('.vw-html')].map((h) => h._viewer);
    const mine = v.find((x) => x.frame.src.includes('index.html')); const theirs = v.find((x) => x.frame.src.includes('page.html'));
    mine.reload(); theirs.reload(); return true; })()`);
  await until(`window.__probes.slice(${before5}).some((p) => p.h1)`, 'reload together with another site', 15000);
  const p4 = await js(`window.__probes.slice(${before5}).find((p) => p.h1)`);
  check(p4.h1 === 'rgb(0, 0, 200)', `previewing another site does not drop this site's unsaved stylesheet (${p4.h1})`);
  await js(`(ide.settings.set('autosave.onTabSwitch', true), ide.settings.set('autosave.onIdle', true), true)`);
  await js(`ide.openFile(${JSON.stringify(html)})`);
  await js(`(ide.closeTab(${JSON.stringify(other)}, true), true)`);

  // Script errors and the width presets.
  await js(`(() => { const m = document.querySelector('.vw-html')._viewer.editor.getModel(); m.applyEdits([{ range: new ide.monaco.Range(m.getLineCount(), 1, m.getLineCount(), 1), text: '<script>undefinedFunction()</script>\\n' }]); return true; })()`);
  await until(`document.querySelector('.vw-html-errors').textContent.includes('1')`, 'script error counted', 15000);
  check(/undefinedFunction/.test(await js(`document.querySelector('.vw-html-errors').title`)), 'script errors are counted with their message');
  await js(`(() => { const s = document.querySelector('.vw-html-width'); s.value = '375'; s.dispatchEvent(new Event('change')); return true; })()`);
  const w = await js(`Math.round(document.querySelector('.vw-html-frame').getBoundingClientRect().width)`);
  check(w === 375, `the Mobile preset fixes the preview at 375 px (${w})`);
  await shot('mobile.png');
  await js(`(() => { const s = document.querySelector('.vw-html-width'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
  await js(`document.querySelector('.vw-html')._viewer.setMode('preview', true)`);
  check(await js(`document.querySelector('.vw-html .vw-md-editor').classList.contains('hidden') && !document.querySelector('.vw-html-stage').classList.contains('hidden')`), 'Preview mode shows only the page');

  // The preview server only serves the site's folder (asked from inside the page, as a page script would).
  check(p1.served.outside === 403 && p1.served.inside === 200, `files outside the project are not served (${JSON.stringify(p1.served)})`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.close();

const k = await launch({ fixture: 'core', port: 9851, name: 'html-preview-ko', lang: 'ko-KR' });
try {
  writeSite(k.project);
  await k.js(`(window.__probes = [], addEventListener('message', (e) => { if (e.data?.probe) window.__probes.push(e.data); }), true)`);
  await openFile(k, 'site/index.html');
  await k.until(`!!document.querySelector('.vw-html .vw-toolbar')`, 'ko viewer');
  // The screenshot shows the page, not the moment before it loads.
  await k.until(`window.__probes.length > 0`, 'ko page loaded in the preview', 20000);
  k.check((await k.js(`window.__probes.at(-1).title`)) === 'Hello preview', 'the page shows in the Korean UI too');
  const leaks = await englishLeaks(k, '.vw-html .vw-toolbar', ['px', 'HTML']);
  k.check(!leaks.length, `the HTML preview toolbar is Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  await k.shot('korean.png');
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
