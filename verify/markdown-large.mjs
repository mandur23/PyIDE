// A 5 MB Markdown file: typing does not re-render its preview (which took 20+ s each time), Refresh Preview renders
// it, and a small file still previews live. Port 8650.
import { launch } from './lib.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const dir = mkdtempSync(path.join(tmpdir(), 'pyide-markdown-large-'));
const big = path.join(dir, 'big.md');
const small = path.join(dir, 'small.md');
writeFileSync(big, Array.from({ length: 60000 }, (_, i) => `## Heading ${i}\n\nSome *text* with a [link](https://example.com) and \`code\` ${'lorem ipsum '.repeat(5)}\n`).join('\n'));
writeFileSync(small, '# Small\n\nhello\n');
const t = await launch({ port: 8650, name: 'markdown-large', projectDir: dir });
const { js, until, check } = t;
try {
  await js(`ide.openFile(${JSON.stringify(big)})`);
  await until(`!!document.querySelector('.vw-md .vw-md-refresh') && !document.querySelector('.vw-md .vw-md-refresh').classList.contains('hidden')`, 'big md open', 60000);
  const renders0 = await js(`Number(document.querySelector('.vw-md').dataset.renders || 0)`);
  const ms = await js(`(async () => { const ed = ide.activeTab().editor || monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('big.md')); const times = []; for (let i = 0; i < 10; i++) { const s = performance.now(); ed.trigger('kb', 'type', { text: 'x' }); await new Promise((r) => setTimeout(r, 250)); times.push(performance.now() - s - 250); } return Math.max(...times); })()`);
  const renders1 = await js(`Number(document.querySelector('.vw-md').dataset.renders || 0)`);
  check(renders1 === renders0 && ms < 1000, `a 5 MB Markdown file is not re-rendered while typing (worst extra delay ${Math.round(ms)} ms, renders ${renders0} -> ${renders1})`);
  check(/Large file/.test(await js(`document.querySelector('.vw-md .vw-status').textContent`)), 'the status says the preview waits for Refresh Preview');
  await js(`(document.querySelector('.vw-md .vw-md-refresh').click(), true)`);
  await until(`Number(document.querySelector('.vw-md').dataset.renders || 0) > ${renders1}`, 'refresh render', 120000);
  check(await js(`document.querySelectorAll('.vw-md-preview h2').length`) > 1000, 'Refresh Preview renders it');
  await js(`ide.openFile(${JSON.stringify(small)})`);
  await until(`[...document.querySelectorAll('.vw-md')].some((h) => h.offsetParent && h.querySelector('.vw-md-preview h1')?.textContent === 'Small')`, 'small md', 20000);
  const smallHost = `[...document.querySelectorAll('.vw-md')].find((h) => h.offsetParent)`;
  check(await js(`${smallHost}.querySelector('.vw-md-refresh').classList.contains('hidden')`), 'a small file has no Refresh Preview button');
  await js(`(async () => { const ed = monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('small.md')); ed.setPosition({ lineNumber: 3, column: 6 }); ed.trigger('kb', 'type', { text: ' world' }); return true; })()`);
  await until(`/hello world/.test(${smallHost}.querySelector('.vw-md-preview').textContent)`, 'small live preview', 5000)
    .then(() => check(true, 'a small file still previews live'), () => check(false, 'a small file still previews live'));
  check(t.consoleErrors.length === 0, `no renderer exceptions ${JSON.stringify(t.consoleErrors).slice(0, 300)}`);
} catch (e) { check(false, e.message); }
t.finish();
rmSync(dir, { recursive: true, force: true });
