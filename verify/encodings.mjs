// Documents and their encodings: detection, a chosen encoding that sticks, re-encodings made outside PyIDE, Convert to,
// CP949 refusals, notebooks with CRLF, and saves that cannot leave a half-written file. Ports 9270.
import { execFileSync } from 'child_process';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');
const codec = require('../main/text-codec.js');
const cjsFs = require('fs');

const KO = '# 한글 주석입니다\nprint("안녕")\n';
// UTF-8 Korean with one stray Latin-1 byte (an é pasted from another program).
const STRAY = Buffer.concat([Buffer.from('# 한글 주석입니다\n', 'utf8'), Buffer.from([0xe9]), Buffer.from('\nx = "안녕"\n', 'utf8')]);

const results = [];
const unit = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// ---------- codec, without a window ----------
{
  const dir = mkdtempSync(path.join(tmpdir(), 'pyide-encodings-unit-'));
  const f = (n) => path.join(dir, n);
  writeFileSync(f('stray.py'), STRAY);
  const stray = codec.read(f('stray.py'));
  unit(stray.encoding === 'utf-8' && stray.text.includes('한글 주석입니다') && stray.text.includes('안녕'),
    `UTF-8 with one invalid byte is read as UTF-8, not as CP949 mojibake (${stray.encoding})`);
  writeFileSync(f('kr949.py'), iconv.encode(KO, 'cp949'));
  const kr = codec.read(f('kr949.py'));
  unit(kr.encoding === 'cp949' && kr.text === KO, `a real CP949 file is still read as CP949 (${kr.encoding})`);

  let refusal = null;
  try { codec.write(f('kr949.py'), '😀\n', 'cp949'); } catch (e) { refusal = e; }
  unit(refusal?.expected === true && /CP949/.test(refusal.message) && readFileSync(f('kr949.py')).equals(iconv.encode(KO, 'cp949')),
    'a CP949 save that would lose characters is refused as an expected error and leaves the file alone');

  writeFileSync(f('plain.py'), 'old = 1\n');
  codec.write(f('plain.py'), 'new = 2\n', 'utf-8');
  unit(readFileSync(f('plain.py'), 'utf8') === 'new = 2\n' && readdirSync(dir).length === 3, `a save replaces the text and leaves no temporary file (${readdirSync(dir)})`);

  // A write that fails after the file was opened (a full disk): the old text must survive.
  writeFileSync(f('full.py'), 'precious = 1\n');
  const realWrite = cjsFs.writeFileSync;
  cjsFs.writeFileSync = (p, data, ...rest) => {
    realWrite(p, Buffer.from(data).subarray(0, 3), ...rest);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  };
  let full = null;
  try { codec.write(f('full.py'), 'precious = 2\n'.repeat(50), 'utf-8'); } catch (e) { full = e; } finally { cjsFs.writeFileSync = realWrite; }
  unit(full?.code === 'ENOSPC' && readFileSync(f('full.py'), 'utf8') === 'precious = 1\n' && !readdirSync(dir).some((n) => n.includes('pyide')),
    `a save that fails halfway (disk full) leaves the old file whole, and no temporary file (${JSON.stringify(readFileSync(f('full.py'), 'utf8'))})`);

  writeFileSync(f('linked.py'), 'a = 1\n');
  linkSync(f('linked.py'), f('other-name.py'));
  codec.write(f('linked.py'), 'a = 2\n', 'utf-8');
  unit(readFileSync(f('other-name.py'), 'utf8') === 'a = 2\n', 'a hard-linked file is written in place, so its other name sees the save');

  writeFileSync(f('ro.py'), 'ro = 1\n');
  chmodSync(f('ro.py'), 0o444);
  let ro = null;
  try { codec.write(f('ro.py'), 'ro = 2\n', 'utf-8'); } catch (e) { ro = e; }
  unit(ro && ['EPERM', 'EACCES'].includes(ro.code) && readFileSync(f('ro.py'), 'utf8') === 'ro = 1\n', `a read-only file is still refused (${ro?.code})`);
  chmodSync(f('ro.py'), 0o666);

  const attrs = (n) => execFileSync('attrib', [f(n)], { encoding: 'utf8' }).slice(0, 12).replace(/\s/g, '');
  writeFileSync(f('marked.py'), 'm = 1\n');
  writeFileSync(`${f('marked.py')}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  writeFileSync(`${f('marked.py')}:pyide.note`, 'kept');
  utimesSync(f('marked.py'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  execFileSync('attrib', ['+h', '+s', f('marked.py')]);
  const before = attrs('marked.py');
  codec.write(f('marked.py'), 'm = 2\n', 'utf-8');
  const stream = (s) => { try { return readFileSync(`${f('marked.py')}:${s}`, 'utf8'); } catch (e) { return e.code; } };
  unit(readFileSync(f('marked.py'), 'utf8') === 'm = 2\n' && attrs('marked.py') === before && before.includes('S') && before.includes('H'),
    `a Hidden System file is saved and stays Hidden and System (${before} -> ${attrs('marked.py')})`);
  unit(stream('Zone.Identifier').includes('ZoneId=3') && stream('pyide.note') === 'kept',
    `and keeps its alternate data streams (${JSON.stringify([stream('Zone.Identifier'), stream('pyide.note')])})`);
  unit(statSync(f('marked.py')).mtimeMs > Date.now() - 60000 && !readdirSync(dir).some((n) => n.includes('pyide-tmp')),
    `and its modified time is the save's, with no temporary file left (${statSync(f('marked.py')).mtime.toISOString()})`);
  execFileSync('attrib', ['-h', '-s', f('marked.py')]);
  writeFileSync(f('hidden.py'), 'h = 1\n');
  linkSync(f('hidden.py'), f('hidden-link.py'));
  execFileSync('attrib', ['+h', f('hidden.py')]);
  let linked = null;
  try { codec.write(f('hidden.py'), 'h = 2\n', 'utf-8'); } catch (e) { linked = e.code; }
  unit(!linked && readFileSync(f('hidden-link.py'), 'utf8') === 'h = 2\n' && attrs('hidden.py').includes('H'),
    `a Hidden hard-linked file is written in place (${linked || attrs('hidden.py')})`);
  execFileSync('attrib', ['-h', f('hidden.py')]);

  writeFileSync(f('timed.py'), 'x = 1\n'.repeat(400));
  const times = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    codec.write(f('timed.py'), `x = ${i}\n`.repeat(400), 'utf-8');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`save of a 2.4 KB file: median ${times[50].toFixed(2)} ms, p90 ${times[90].toFixed(2)} ms`);
  unit(times[50] < 20, `a small file saves in a few ms (median ${times[50].toFixed(2)} ms)`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- in the IDE ----------
const t = await launch({ fixture: 'core', port: 9270, name: 'encodings' });
const { js, until, press, type, check, sleep } = t;
for (const ok of results) t.results.push({ ok, label: 'codec' });
const p = (n) => path.join(t.project, n);
const status = () => js(`document.querySelector('#statusEncoding').textContent`);
const model = () => js(`ide.editor.getModel().getValue()`);
// Repeats of one error are counted on its entry.
const errors = () => js(`ide.api.invoke('diagnostics:errors').then((l) => l.reduce((n, e) => n + (e.count || 1), 0))`);
const dialogText = () => js(`[...document.querySelectorAll('.dialog-message')].map((n) => n.textContent).pop() || ''`);
const closeDialog = async () => {
  for (let i = 0; i < 5 && await js(`!!document.querySelector('.dialog')`); i++) {
    await js(`(() => { const b = [...document.querySelectorAll('.dialog-buttons button')]; (b.find((x) => x.textContent === 'Cancel') || b[b.length - 1])?.click(); return true; })()`);
    await sleep(200);
  }
  await until(`!document.querySelector('.dialog')`, 'dialog closed');
};
async function menuItem(label) {
  await js(`(ide.ui.closeMenus(), document.querySelector('#statusEncoding').click(), true)`);
  await until(`!!document.querySelector('.context-menu')`, 'encoding menu');
  return `[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)})`;
}
async function pick(label) {
  const item = await menuItem(label);
  await js(`${item}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(300);
}
const appendLine = async (text) => {
  await js(`(() => { const m = ide.editor.getModel(); const l = m.getLineCount(); ide.editor.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); ide.editor.focus(); return true; })()`);
  await type(text);
};

try {
  // A3: a stray byte no longer turns a UTF-8 file into CP949 mojibake, and it saves.
  writeFileSync(p('stray.py'), STRAY);
  await openFile(t, 'stray.py');
  check((await status()) === 'UTF-8' && (await model()).includes('한글 주석입니다'), `a UTF-8 file with one invalid byte opens as UTF-8 with its Korean intact (${await status()})`);
  await appendLine('\nedited = 1');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab()) || !!document.querySelector('.dialog')`, 'stray.py saved');
  check(!(await js(`!!document.querySelector('.dialog')`)) && readFileSync(p('stray.py'), 'utf8').includes('한글 주석입니다') && readFileSync(p('stray.py'), 'utf8').includes('edited = 1'),
    'saving it writes UTF-8 with the Korean intact');
  if (await js(`!!document.querySelector('.dialog')`)) await closeDialog();

  // A13: the CP949 refusal is the user's message, not an IDE internal error.
  while (await js(`!!document.querySelector('.dialog')`)) await closeDialog();
  writeFileSync(p('emoji949.py'), iconv.encode(KO, 'cp949'));
  await openFile(t, 'emoji949.py');
  const errorsBefore = await errors();
  await appendLine('\n# 😀');
  await press('Ctrl+S');
  await until(`[...document.querySelectorAll('.dialog-message')].some((n) => n.textContent.includes('emoji949.py'))`, 'cp949 refusal');
  const said = await dialogText();
  await closeDialog();
  await sleep(300);
  check(/CP949/.test(said) && (await errors()) === errorsBefore, `a refused CP949 save shows its reason and adds no IDE internal error (${JSON.stringify(said)})`);
  // Ctrl+S is Save All: the unsavable edit would be refused again on every later save.
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // A12: a notebook with CRLF line breaks keeps them when it is saved.
  const nb = { cells: [{ cell_type: 'code', execution_count: null, id: 'a1', metadata: {}, outputs: [], source: ['x = 1'] }],
    metadata: {}, nbformat: 4, nbformat_minor: 5 };
  writeFileSync(p('nb.ipynb'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${JSON.stringify(nb, null, 1)}\n`.replace(/\n/g, '\r\n'))]));
  await js(`ide.openFile(${JSON.stringify(p('nb.ipynb'))})`);
  await until(`!!ide.activeTab()?.notebook`, 'notebook open', 20000);
  await js(`ide.activeTab().notebook.cells()[0].model.setValue('x = 2')`);
  await sleep(500);
  await js(`ide.saveTab(ide.activeTab())`);
  await until(`!ide.isDirty(ide.activeTab())`, 'notebook saved');
  const nbText = readFileSync(p('nb.ipynb'), 'utf8');
  check(nbText.includes('x = 2') && nbText.charCodeAt(0) === 0xfeff && !/[^\r]\n/.test(nbText), `a CRLF notebook is saved with CRLF and its BOM (LF-only lines: ${(nbText.match(/[^\r]\n/g) || []).length})`);

  // A2: Reload in <encoding> sticks: a window focus or a watcher event does not decode the file the old way again.
  writeFileSync(p('kr949.py'), iconv.encode(KO, 'cp949'));
  await openFile(t, 'kr949.py');
  await until(`document.querySelector('#statusEncoding').textContent.startsWith('CP949')`, 'kr949 is CP949');
  await pick('Reload in UTF-8');
  await until(`document.querySelector('#statusEncoding').textContent === 'UTF-8'`, 'reloaded in UTF-8');
  const asUtf8 = iconv.encode(KO, 'cp949').toString('utf8');
  await js(`(window.dispatchEvent(new Event('focus')), true)`);
  await sleep(1200);
  check((await model()) === asUtf8 && (await status()) === 'UTF-8' && !(await js(`ide.isDirty(ide.activeTab())`)),
    'after Reload in UTF-8, a window focus keeps the UTF-8 text (the status bar and the text agree)');
  await pick('Reload in CP949 (EUC-KR)');
  await until(`document.querySelector('#statusEncoding').textContent.startsWith('CP949')`, 'back to CP949');
  check((await model()) === KO, 'Reload in CP949 brings the Korean back');

  // A5: a file re-encoded outside PyIDE while open takes the new encoding, and saves keep it.
  writeFileSync(p('ext_utf8.py'), 'print("utf8")\n');
  await openFile(t, 'ext_utf8.py');
  writeFileSync(p('ext_utf8.py'), Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('print("utf16")\n', 'utf-16le')]));
  await until(`ide.editor.getModel().getValue() === 'print("utf16")\\n'`, 'reloaded after the re-encode', 10000);
  check((await status()) === 'UTF-16 LE', `a file rewritten as UTF-16 LE on disk shows UTF-16 LE after the reload (${await status()})`);
  await appendLine('\nx = 1');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'ext_utf8 saved');
  const ext = readFileSync(p('ext_utf8.py'));
  check(ext[0] === 0xff && ext[1] === 0xfe && iconv.decode(ext.subarray(2), 'utf-16le') === 'print("utf16")\n\nx = 1', `the next save keeps UTF-16 LE (${JSON.stringify(iconv.decode(ext.subarray(2), 'utf-16le'))})`);
  writeFileSync(p('ext_cp949.py'), iconv.encode(KO, 'cp949'));
  await openFile(t, 'ext_cp949.py');
  await until(`document.querySelector('#statusEncoding').textContent.startsWith('CP949')`, 'ext_cp949 is CP949');
  writeFileSync(p('ext_cp949.py'), '# 😀 now UTF-8\n');
  await until(`ide.editor.getModel().getValue() === '# 😀 now UTF-8\\n'`, 'reloaded as UTF-8', 10000);
  check((await status()) === 'UTF-8', `a CP949 file rewritten as UTF-8 on disk shows UTF-8 (${await status()})`);
  await appendLine('\ny = 2');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab()) || !!document.querySelector('.dialog')`, 'ext_cp949 saved');
  check(readFileSync(p('ext_cp949.py'), 'utf8') === '# 😀 now UTF-8\n\ny = 2', `and saves as UTF-8 instead of refusing the emoji (${JSON.stringify(readFileSync(p('ext_cp949.py'), 'utf8'))} ${JSON.stringify(await dialogText())})`);
  if (await js(`!!document.querySelector('.dialog')`)) await closeDialog();

  // A9: Convert to on a modified document goes through the normal save, so it leaves no stale disk fingerprint.
  writeFileSync(p('dirtyconv.py'), 'a = 1\n');
  await openFile(t, 'dirtyconv.py');
  await appendLine('\nb = 2');
  await pick('Convert to UTF-8 BOM');
  await until(`document.querySelector('#statusEncoding').textContent === 'UTF-8 BOM'`, 'converted to UTF-8 BOM', 5000).catch(async () => {
    console.log(`  status ${await status()}, dialog ${JSON.stringify(await dialogText())}, menu ${await js(`!!document.querySelector('.context-menu')`)}`);
  });
  check(!(await js(`ide.isDirty(ide.activeTab())`)) && readFileSync(p('dirtyconv.py')).equals(Buffer.from('﻿a = 1\n\nb = 2', 'utf8')),
    `Convert to on a modified document writes its text in the new encoding and leaves it unmodified (${readFileSync(p('dirtyconv.py')).toString('hex')})`);
  await appendLine('\nc = 3');
  await press('Ctrl+S');
  await sleep(800);
  check(!(await js(`!!document.querySelector('.dialog')`)) && !(await js(`ide.isDirty(ide.activeTab())`)) && readFileSync(p('dirtyconv.py')).subarray(0, 3).toString('hex') === 'efbbbf'
    && readFileSync(p('dirtyconv.py'), 'utf8').endsWith('c = 3'),
  `after Convert to, the next save writes without a false File Cache Conflict (${JSON.stringify(await dialogText())} ${JSON.stringify(readFileSync(p('dirtyconv.py'), 'utf8'))})`);
  if (await js(`!!document.querySelector('.dialog')`)) await closeDialog();
  await appendLine('\nd = 4');
  await js(`ide.autoSave()`);
  await until(`!ide.isDirty(ide.activeTab())`, 'auto saved', 5000).catch(() => {});
  check(readFileSync(p('dirtyconv.py'), 'utf8').endsWith('d = 4'), 'and auto save keeps saving it');

  // A10: a conversion PyIDE could not read back (BOM-less UTF-16 of Korean-only text) is refused.
  const koonly = '한글만있는파일\n가나다라마바사\n';
  writeFileSync(p('koonly.txt'), koonly);
  await openFile(t, 'koonly.txt');
  await pick('Convert to UTF-16 LE (no BOM)');
  await until(`!!document.querySelector('.dialog .dialog-message')`, 'refusal shown', 5000).catch(() => {});
  const refusal = await dialogText();
  check(/UTF-16 LE \(no BOM\)/.test(refusal) && readFileSync(p('koonly.txt'), 'utf8') === koonly && (await status()) === 'UTF-8',
    `Convert to UTF-16 LE (no BOM) on Korean-only text is refused and the file is unchanged (${JSON.stringify(refusal)})`);
  if (await js(`!!document.querySelector('.dialog')`)) await closeDialog();

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
t.finish();
