// Inlay hints and Power Save Mode (renderer/features/inlay-hints). PyCharm turns inlays off in Power Save Mode: the
// hints disappear, typing sends Pyright no hover or signatureHelp for them, and they come back, for the lines typed
// meanwhile too, when it is turned off. Requests are counted by the inlay-hints plugin in their async stack. Port 9516.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const project = path.join(tempDir('inlay-hints'), 'proj');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'shapes.py'), [
  'def area(width, height):',
  '    return width * height',
  '',
  '',
  'size = area(3, 4)',
  '',
].join('\n'));

const t = await launch({ fixture: 'core', port: 9516, name: 'inlay-hints', projectDir: project });
const { js, until, type, check, sleep } = t;

// Hint labels drawn in the editor: Monaco shows each as injected text before or after a position.
const HINTS = `ide.editor.getModel().getAllDecorations().map((d) => [d.range.startLineNumber, (d.options.before || d.options.after)?.content?.trim()]).filter(([, c]) => c)`;
const hintsOn = (line, label) => `(${HINTS}).some(([l, c]) => l === ${line} && c === ${JSON.stringify(label)})`;
const requests = () => js(`__inlayRequests.length`);

try {
  await js(`(() => {
    window.__inlayRequests = [];
    const inv = ide.api.invoke;
    ide.api.invoke = function (ch, method, ...rest) {
      if (ch === 'lsp:request' && (method === 'textDocument/hover' || method === 'textDocument/signatureHelp') && /inlay-hints/.test(new Error().stack)) __inlayRequests.push(method);
      return inv.call(this, ch, method, ...rest);
    };
    return true;
  })()`);
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(t, 'shapes.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  await until(hintsOn(5, 'width:'), 'parameter name hint on area(3, 4)', 30000);
  check(true, 'area(3, 4) shows the width: hint');
  const before = await requests();
  check(before > 0, `the hints come from Pyright hover/signatureHelp requests (${before})`);

  await js(`(ide.powerSave.set(true), true)`);
  await until(`(${HINTS}).length === 0`, 'hints gone in Power Save Mode', 10000).catch(() => {});
  check(await js(`(${HINTS}).length === 0`), `Power Save Mode hides the inlay hints (${JSON.stringify(await js(HINTS))})`);
  await js(`(__inlayRequests.length = 0, true)`);
  await js(`(() => { const e = ide.editor; e.focus(); e.setPosition({ lineNumber: 6, column: 1 }); return true; })()`);
  for (const ch of 'extra = area(7, 8)') await type(ch);
  await js(`(ide.inlayHints.refresh(), true)`);
  await sleep(5000);
  const during = await js(`__inlayRequests.slice()`);
  check(during.length === 0, `typing a line in Power Save Mode sends no inlay hint requests (${JSON.stringify(during)})`);
  check(await js(`(${HINTS}).length === 0`), `no hints appear for the typed line in Power Save Mode (${JSON.stringify(await js(HINTS))})`);

  await js(`(__inlayRequests.length = 0, ide.powerSave.set(false), true)`);
  const back = await until(`${hintsOn(5, 'width:')} && ${hintsOn(6, 'width:')}`, 'hints back after Power Save Mode', 30000).catch(() => false);
  check(back, `turning Power Save Mode off brings the hints back, for the typed line too (${JSON.stringify(await js(HINTS))})`);
  check(await requests() > 0, `and asks Pyright again (${await requests()} requests)`);
} catch (err) {
  check(false, err.stack || err.message);
}
t.finish();
