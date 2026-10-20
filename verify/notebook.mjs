// End-to-end check for the Jupyter notebook plugin (renderer/features/notebook, main/features/notebook.js).
// Kernels need ipykernel, so the suite keeps a venv with ipykernel and nbformat in verify/out/notebook-venv (created
// on the first run). NOTEBOOK_INSTALL=1 also installs ipykernel into a fresh venv through the notebook's Install button.
// Ports 9670-9672.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const VENV = path.join(OUT, 'notebook-venv');
const VENV_PY = path.join(VENV, 'Scripts', 'python.exe');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, windowsHide: true });

function ensureVenv() {
  if (existsSync(VENV_PY)) {
    try { run(VENV_PY, ['-c', 'import ipykernel, nbformat']); return; } catch {}
  } else {
    console.log('creating verify/out/notebook-venv (one time)…');
    try { run('py', ['-3', '-m', 'venv', VENV]); } catch { run('python', ['-m', 'venv', VENV]); }
  }
  run(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'ipykernel', 'nbformat']);
}

// A fresh venv without ipykernel, for the install offer.
function bareVenv() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-nb-bare-')), 'venv');
  run(run(VENV_PY, ['-c', 'import sys; print(sys._base_executable)']).trim(), ['-m', 'venv', dir]);
  return path.join(dir, 'Scripts', 'python.exe');
}

ensureVenv();

const H = 'ide.activeTab().host';
const HS = '.custom-tab:not(.hidden).nb-host'; // the same element, as a CSS selector for click()
const V = 'ide.activeTab().notebook';

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${JSON.stringify(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${JSON.stringify(exe)})`, 'interpreter selected');
}

const cellText = (t, i) => t.js(`${H}.querySelectorAll('.nb-cell')[${i}].innerText`);
const outputsText = (t, i) => t.js(`${H}.querySelectorAll('.nb-cell')[${i}].querySelector('.nb-outputs').innerText`);
const prompt = (t, i) => t.js(`${H}.querySelectorAll('.nb-cell')[${i}].querySelector('.nb-prompt').textContent`);
const settled = (t, label, ms = 60000) => t.until(`${H}.dataset.kernel === 'idle' && !${H}.querySelector('.nb-cell.running, .nb-cell.queued')`, label, ms);
async function setSource(t, i, code) {
  await t.js(`${V}.cells()[${i}].model.setValue(${JSON.stringify(code)})`);
}
async function runAt(t, i, code, label) {
  if (code !== undefined) await setSource(t, i, code);
  await t.js(`${V}.runCell(${i})`);
  await t.until(`!${H}.querySelectorAll('.nb-cell')[${i}].matches('.running, .queued') && ${H}.dataset.kernel === 'idle'`, label, 60000);
}
async function addCodeCell(t, code) {
  const i = await t.js(`${V}.cells().length`);
  await t.js(`${V}.insertCell(${i}, 'code')`);
  if (code !== undefined) await setSource(t, i, code);
  return i;
}

// ---------- English session ----------
const t = await launch({ fixture: 'notebook', port: 9670, name: 'notebook' });
const { js, until, press, type, click, check, shot, sleep } = t;
try {
  await until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(t, VENV_PY);
  check(await js(`ide.installables.some(i => i.id === 'pip:ipykernel')`), 'ipykernel is listed in the Install Manager');

  // ---------- open ----------
  await openFile(t, 'analysis.ipynb');
  await until(`${H}?.classList.contains('nb-host') && ${H}.dataset.cells === '4'`, 'notebook view with 4 cells');
  check(true, 'analysis.ipynb opens as a notebook with its 4 cells');
  await until(`${H}.querySelector('.nb-md h1')?.textContent === 'Sales analysis'`, 'markdown rendered');
  check(await js(`${H}.querySelector('.nb-md strong')?.textContent === 'bold' && ${H}.querySelectorAll('.nb-md li').length === 2`), 'Markdown cell renders bold text and a list');
  check(await js(`!window.__nbInjected && !${H}.querySelector('.nb-md script, .nb-md [onerror]')`), 'scripts and event handlers in Markdown are stripped');
  check(await js(`${H}.querySelector('.nb-md a')?.getAttribute('href') === 'https://example.com'`), 'Markdown links are kept');
  check((await outputsText(t, 1)).includes('saved output line 2') && (await outputsText(t, 1)).includes('42'), 'saved outputs are shown');
  check(await prompt(t, 1) === '[3]:', 'saved execution count shows as [3]:');
  check((await cellText(t, 2)).replace(/ /g, ' ').includes('raw cell text'), 'raw cell shows its text');
  check(await js('!ide.isDirty(ide.activeTab())'), 'opening does not dirty the file');
  check(await js(`${H}.querySelector('.nb-kernel-text').textContent === 'Kernel not started'`), 'kernel starts lazily');
  await shot('notebook-open.png');

  // ---------- edit with real keys, Shift+Enter ----------
  await js(`${V}.cells()[3].el.scrollIntoView({ block: 'center' })`);
  await sleep(100);
  await click(`${HS} .nb-cell:nth-child(4) .nb-input`);
  await until(`${V}.cells()[3].editor?.hasTextFocus()`, 'cell 4 editor focused');
  check(await js(`${H}.dataset.mode === 'edit' && ${H}.dataset.selected === '3'`), 'clicking a code cell enters edit mode');
  await type('value = 6 * 7');
  await type('\nvalue'); // CDP key presses carry no text, so the newline is typed
  check(await js(`${V}.cells()[3].model.getValue()`) === 'value = 6 * 7\nvalue', 'typing edits the cell');
  await until('ide.isDirty(ide.activeTab())', 'dirty after edit');
  check(true, 'editing a cell marks the notebook modified');
  await press('Shift+Enter');
  await until(`${H}.dataset.cells === '5'`, 'Shift+Enter on the last cell adds one', 5000).then(() => check(true, 'Shift+Enter on the last cell adds a new cell'), () => check(false, 'Shift+Enter on the last cell adds a new cell'));
  check(await js(`${V}.cells()[3].model.getValue()`) === 'value = 6 * 7\nvalue', 'Shift+Enter does not insert a newline');
  await until(`${V}.cells()[4].editor?.hasTextFocus()`, 'new cell focused', 5000).then(() => check(true, 'the new cell gets the caret'), () => check(false, 'the new cell gets the caret'));
  await until(`${H}.querySelectorAll('.nb-cell')[3].querySelector('.nb-outputs').innerText.includes('42')`, 'kernel output 42', 90000);
  check(true, 'the kernel starts and the cell result 42 is shown');
  await settled(t, 'kernel idle');
  check(await prompt(t, 3) === '[1]:', 'execution count [1]: after the first run');
  check(/^Python \d+\.\d+/.test(await js(`${H}.querySelector('.nb-kernel-text').textContent`)), 'kernel status names the Python version');
  check(await js(`${H}.querySelector('.nb-cell:nth-child(4) .nb-status').textContent.startsWith('✓')`), 'execution time is shown');

  // ---------- real output, the project interpreter ----------
  await runAt(t, 4, 'import sys\nprint("hello from kernel")\nprint(sys.executable)', 'print cell');
  const printed = await outputsText(t, 4);
  check(printed.includes('hello from kernel'), 'stdout from the kernel is shown');
  check(printed.toLowerCase().includes(VENV_PY.toLowerCase()), 'the kernel runs in the selected project interpreter');
  await runAt(t, 4, 'for i in range(3):\n    print(f"step {i}", end="\\r")\nprint("finished words")\nprint("ab\\bc")', 'progress output');
  const progress = await js(`${H}.querySelectorAll('.nb-cell')[4].querySelector('.nb-stream').textContent`);
  check(progress === 'finished words\nac\n', `\\r rewinds the line and \\b deletes a character, keeping the words (${JSON.stringify(progress)})`);
  await runAt(t, 4, 'import helper\nhelper.greet("notebook")', 'project import');
  check((await outputsText(t, 4)).includes("'hello notebook'"), 'modules next to the notebook import (cwd is its folder)');

  // ---------- image and HTML output ----------
  const img = await addCodeCell(t, [
    'import struct, zlib',
    'from IPython.display import Image, HTML, display',
    'def png(w, h):',
    '    raw = b"".join(b"\\x00" + bytes([200, 30, 30]) * w for _ in range(h))',
    '    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)',
    '    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")',
    'display(Image(png(12, 8)))',
    'display(HTML("<table><tr><th>a</th><td id=\'cell\'>html table</td></tr></table><script>document.body.dataset.ran = 1</script>"))',
  ].join('\n'));
  await runAt(t, img, undefined, 'image cell');
  await until(`${H}.querySelectorAll('.nb-cell')[${img}].querySelector('img.nb-image')?.naturalWidth === 12`, 'png decoded', 10000);
  check(true, 'image/png output renders as an image (12x8)');
  const frame = `${H}.querySelectorAll('.nb-cell')[${img}].querySelector('iframe.nb-html')`;
  check(await js(`${frame}?.getAttribute('sandbox') === 'allow-scripts'`), 'HTML output renders in a sandboxed iframe');
  check(await js(`(() => { try { return ${frame}.contentDocument === null; } catch { return true; } })()`), 'the HTML frame cannot reach the IDE document');
  await until(`parseInt(${frame}.style.height) > 20`, 'iframe fits its content', 10000).then(() => check(true, 'the HTML frame grows to its content'), () => check(false, 'the HTML frame grows to its content'));
  await shot('notebook-image.png');

  // ---------- error output ----------
  const err = await addCodeCell(t, 'def boom():\n    return 1 / 0\nboom()');
  await runAt(t, err, undefined, 'error cell');
  const tb = await outputsText(t, err);
  check(tb.includes('ZeroDivisionError') && tb.includes('boom()'), 'errors show the traceback');
  check(await js(`!!${H}.querySelectorAll('.nb-cell')[${err}].querySelector('.nb-error span[class*="nb-fg"]')`), 'traceback ANSI colors are rendered');
  check(await js(`${H}.querySelectorAll('.nb-cell')[${err}].querySelector('.nb-status').classList.contains('failed')`), 'a failed cell is marked');

  // Run All stops at the error: later cells are aborted, not run.
  const after = await addCodeCell(t, 'print("after the error")');
  await js(`${V}.runAll()`);
  await settled(t, 'run all');
  check(!(await outputsText(t, after)).includes('after the error'), 'Run All stops at the first error');
  check(await prompt(t, after) === '[ ]:', 'the cell after the error was not run');

  // ---------- stdin ----------
  const ask = await addCodeCell(t, 'name = input("Your name? ")\nprint("hi", name)');
  await js(`${V}.runCell(${ask})`);
  await until(`${H}.querySelector('.nb-stdin-input')`, 'stdin prompt', 30000);
  check((await outputsText(t, ask)).includes('Your name?'), 'input() shows its prompt in the cell');
  await click(`${HS} .nb-stdin-input`);
  await type('Ada');
  await press('Enter');
  await settled(t, 'stdin cell');
  check((await outputsText(t, ask)).includes('hi Ada'), 'typed input reaches the kernel');

  // ---------- interrupt ----------
  const slow = await addCodeCell(t, 'import time\ntime.sleep(120)');
  await js(`${V}.runCell(${slow})`);
  await until(`${H}.dataset.kernel === 'busy'`, 'busy');
  await until(`!${H}.querySelector('.nb-interrupt').disabled`, 'interrupt enabled');
  const started = Date.now();
  await click(`${HS} .nb-interrupt`);
  await until(`${H}.querySelectorAll('.nb-cell')[${slow}].querySelector('.nb-outputs').innerText.includes('KeyboardInterrupt')`, 'KeyboardInterrupt', 20000);
  check(Date.now() - started < 10000, 'Interrupt Kernel stops a blocking time.sleep at once');
  await settled(t, 'idle after interrupt');
  await runAt(t, slow, 'value * 2', 'after interrupt');
  check((await outputsText(t, slow)).includes('84'), 'the kernel keeps its state after an interrupt');

  // ---------- completion from the kernel ----------
  const comp = await addCodeCell(t, 'import collections\ncollections.Ord');
  await js(`${V}.edit(${comp})`);
  await js(`(() => { const ed = ${V}.cells()[${comp}].editor; ed.setPosition({ lineNumber: 2, column: 16 }); ed.focus(); ed.trigger('test', 'editor.action.triggerSuggest', {}); })()`);
  await until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].some(r => r.textContent.includes('OrderedDict'))`, 'kernel completion', 15000)
    .then(() => check(true, 'code cells complete names from the kernel'), () => check(false, 'code cells complete names from the kernel'));
  await press('Escape');
  await press('Escape');
  await sleep(200);
  check(await js(`${H}.dataset.mode === 'command'`), 'Esc leaves edit mode');

  // ---------- cell structure ----------
  const n0 = await js(`${V}.cells().length`);
  await js(`${V}.select(0)`);
  await js(`${H}.querySelector('.nb-scroll').focus()`);
  await press('b');
  check(await js(`${V}.cells().length`) === n0 + 1 && await js(`${H}.dataset.selected`) === '1', 'B adds a cell below');
  await press('m');
  check(await js(`${V}.cells()[1].el.dataset.type`) === 'markdown', 'M turns it into Markdown');
  await press('Enter');
  await until(`${V}.cells()[1].editor?.hasTextFocus()`, 'md edit');
  await type('## Notes');
  await press('Shift+Enter');
  await until(`${H}.querySelectorAll('.nb-cell')[1].querySelector('.nb-md h2')?.textContent === 'Notes'`, 'markdown rendered after Shift+Enter', 5000)
    .then(() => check(true, 'Shift+Enter renders a Markdown cell'), () => check(false, 'Shift+Enter renders a Markdown cell'));
  await js(`${V}.select(1)`);
  await js(`${H}.querySelector('.nb-scroll').focus()`);
  await click(`${HS} .nb-move-down`);
  check(await js(`${V}.cells()[2].el.dataset.type`) === 'markdown', 'Move Cell Down moves the cell');
  await click(`${HS} .nb-move-up`);
  check(await js(`${V}.cells()[1].el.dataset.type`) === 'markdown', 'Move Cell Up moves it back');
  await js(`${H}.querySelector('.nb-scroll').focus()`);
  await press('d');
  await press('d');
  check(await js(`${V}.cells().length`) === n0 && await js(`${V}.cells()[1].el.dataset.type`) === 'code', 'D D deletes the selected cell');
  await press('z');
  check(await js(`${V}.cells().length`) === n0 + 1 && await js(`${V}.cells()[1].model.getValue()`) === '## Notes', 'Z restores the deleted cell');
  await click(`${HS} .nb-delete`);
  check(await js(`${V}.cells().length`) === n0, 'the toolbar deletes a cell');

  // ---------- save and reopen ----------
  await press('Ctrl+S');
  await until('!ide.isDirty(ide.activeTab())', 'saved');
  check(true, 'Ctrl+S saves the notebook');
  const file = path.join(t.project, 'analysis.ipynb');
  const text = readFileSync(file, 'utf8');
  const nb = JSON.parse(text);
  check(text.startsWith('{\n "cells": [\n  {\n') && text.endsWith('}\n'), 'saved as Jupyter formats it (sorted keys, one-space indent)');
  check(nb.nbformat === 4 && nb.nbformat_minor === 5, 'nbformat 4.5 is kept');
  check(nb.metadata.pyide_test?.keep === 'this' && nb.metadata.language_info.version === '3.12.0', 'notebook metadata is kept');
  check(nb.cells[0].id === 'intro01' && nb.cells[0].metadata.tags[0] === 'header', 'cell ids and tags are kept');
  check(nb.cells[1].metadata.custom?.a === 1 && nb.cells[2].metadata.format === 'text/plain', 'cell metadata of code and raw cells is kept');
  check(nb.cells.every((c) => typeof c.id === 'string' && c.id.length >= 1), 'every cell has an id (nbformat 4.5)');
  check(Array.isArray(nb.cells[0].source) && nb.cells[0].source[0] === '# Sales analysis\n', 'sources are stored as lists of lines');
  const saved = nb.cells.find((c) => c.source.join('') === 'value = 6 * 7\nvalue');
  check(Number.isInteger(saved?.execution_count) && saved.outputs[0]?.data?.['text/plain'][0] === '42', 'outputs and execution counts are saved');
  const pngCell = nb.cells.find((c) => c.outputs?.some((o) => o.data?.['image/png']));
  check(!!pngCell && typeof pngCell.outputs[0].data['image/png'] === 'string', 'image outputs are saved as base64');
  const errCell = nb.cells.find((c) => c.outputs?.some((o) => o.output_type === 'error'));
  check(errCell?.outputs.find((o) => o.output_type === 'error').ename === 'ZeroDivisionError', 'error outputs are saved');
  let valid = '';
  try { valid = run(VENV_PY, ['-c', 'import sys, nbformat; nbformat.validate(nbformat.read(sys.argv[1], as_version=4)); print("valid")', file]).trim(); } catch (e) { valid = String(e.stdout || e.message); }
  check(valid === 'valid', `nbformat.validate accepts the saved file${valid === 'valid' ? '' : `: ${valid.slice(0, 300)}`}`);

  const promptsBefore = await js(`[...${H}.querySelectorAll('.nb-prompt')].map(p => p.textContent).join(' ')`);
  await js(`ide.closeTab(ide.activeTab().path)`);
  await until(`!ide.tabs.some(t => t.path.endsWith('analysis.ipynb'))`, 'closed');
  await openFile(t, 'analysis.ipynb');
  await until(`${H}?.classList.contains('nb-host') && ${H}.dataset.cells === '${nb.cells.length}'`, 'reopened');
  check(true, 'the saved notebook reopens with every cell');
  await until(`[...${H}.querySelectorAll('img.nb-image')].some(i => i.naturalWidth === 12)`, 'image after reopen', 10000)
    .then(() => check(true, 'saved image output renders after reopening'), () => check(false, 'saved image output renders after reopening'));
  check(await js(`[...${H}.querySelectorAll('.nb-prompt')].map(p => p.textContent).join(' ')`) === promptsBefore, 'saved execution counts show after reopening');
  check(await js(`${H}.dataset.kernel`) === 'none', 'closing the tab shut the kernel down; reopening starts fresh');

  // ---------- restart ----------
  const probe = await addCodeCell(t, 'x = 5\nx');
  await runAt(t, probe, undefined, 'probe');
  await click(`${HS} .nb-restart`);
  await until(`${H}.dataset.kernel === 'restarting'`, 'restarting', 5000).catch(() => {});
  await until(`${H}.dataset.kernel === 'idle'`, 'restarted', 60000);
  await runAt(t, probe, "'x' in globals()", 'after restart');
  check((await outputsText(t, probe)).includes('False'), 'Restart Kernel clears the kernel state');

  // ---------- output flood: a stream output keeps its last 1 MB ----------
  const flood = await addCodeCell(t, 'for i in range(200000):\n    print("line", i)');
  await runAt(t, flood, undefined, 'flood');
  const streamLen = await js(`${V}.cells()[${flood}].data.outputs[0]?.text.length`);
  const streamText = await js(`${H}.querySelectorAll('.nb-cell')[${flood}].querySelector('.nb-stream').textContent`);
  check(streamLen <= 1024 * 1024 && streamText.endsWith('line 199999\n') && !streamText.startsWith('line 0\n'), `a flooding cell keeps only the last 1 MB of its output (${streamLen} chars)`);
  check(await js(`!!${H}.querySelectorAll('.nb-cell')[${flood}].querySelector('.nb-dropped') && !${V}.serialize().includes('"dropped"')`), 'the cut is noted in the cell, not written into the file');

  // ---------- stdout and stderr taking turns: each switch is a new output, and their number is bounded ----------
  const turns = await addCodeCell(t, 'import sys\nfor i in range(3000):\n    print("out", i, flush=True)\n    print("err", i, file=sys.stderr, flush=True)');
  await runAt(t, turns, undefined, 'alternating streams');
  const turnOuts = await js(`(() => { const o = ${V}.cells()[${turns}].data.outputs; return { n: o.length, last: o[o.length - 1]?.text || '',
    nodes: ${H}.querySelectorAll('.nb-cell')[${turns}].querySelectorAll('.nb-output').length,
    note: !!${H}.querySelectorAll('.nb-cell')[${turns}].querySelector('.nb-outputs > .nb-dropped') }; })()`);
  check(turnOuts.n > 2 && turnOuts.n <= 500 && turnOuts.nodes === turnOuts.n && turnOuts.last.includes('err 2999') && turnOuts.note,
    `a cell alternating stdout and stderr keeps only its latest 500 outputs, noting the cut (${JSON.stringify({ ...turnOuts, last: turnOuts.last.slice(-12) })})`);

  // ---------- clear_output(wait=True) replaces the output on the page too ----------
  const clearing = await addCodeCell(t, 'from IPython.display import clear_output\nimport time\nfor i in range(5):\n    clear_output(wait=True)\n    print("step", i)\n    time.sleep(0.05)');
  await runAt(t, clearing, undefined, 'clear_output progress');
  const clearingText = await outputsText(t, clearing);
  check(clearingText.trim() === 'step 4' && await js(`${H}.querySelectorAll('.nb-cell')[${clearing}].querySelectorAll('.nb-output').length === 1`),
    `clear_output(wait=True) leaves only the latest output on the page (${JSON.stringify(clearingText)})`);

  // ---------- a dead kernel ----------
  const die = await addCodeCell(t, 'import os\nos._exit(1)');
  await js(`${V}.runCell(${die})`);
  await until(`${H}.dataset.kernel === 'dead'`, 'kernel died', 30000);
  check(await js(`${H}.querySelector('.nb-banner').textContent.includes('kernel died')`), 'a kernel that exits shows the Kernel died banner');
  await js(`${V}.runCell(${probe})`);
  await until(`!${H}.querySelectorAll('.nb-cell')[${probe}].matches('.running, .queued')`, 'run on a dead kernel ends', 10000)
    .then(() => check(true, 'running a cell on a dead kernel does not hang'), () => check(false, 'running a cell on a dead kernel does not hang'));
  await click(`${HS} .nb-banner button.primary`);
  await until(`${H}.dataset.kernel === 'idle'`, 'restarted after death', 60000);
  await runAt(t, probe, '6 * 7', 'after death');
  check((await outputsText(t, probe)).includes('42'), 'Restart Kernel brings a dead kernel back');
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---------- invalid file ----------
  await openFile(t, 'broken.ipynb');
  await until(`${H}?.dataset.invalid === 'true'`, 'invalid notebook');
  check(await js(`${H}.querySelector('.nb-banner').textContent.includes('cannot be opened')`), 'an invalid notebook explains the problem');
  await click(`${HS} .nb-banner button.primary`);
  await until(`ide.activeTab()?.kind === 'file' && ide.activeTab().path.endsWith('broken.ipynb')`, 'opened as text');
  check(true, 'Open as Text shows the JSON in the text editor');
  await js('ide.closeAllTabs(true)');

  // ---------- missing ipykernel ----------
  const bare = bareVenv();
  await useInterpreter(t, bare);
  writeFileSync(path.join(t.project, 'fresh.ipynb'), '');
  await openFile(t, 'fresh.ipynb');
  await until(`${H}?.dataset.cells === '1'`, 'empty file opens as a new notebook');
  check(true, 'an empty .ipynb opens as a new notebook with one cell');
  await setSource(t, 0, '1 + 1');
  await js(`${V}.runCell(0)`);
  await until(`${H}.dataset.kernel === 'missing'`, 'missing kernel', 30000);
  check(await js(`!!${H}.querySelector('.nb-banner .nb-install')`), 'without ipykernel the notebook offers to install it');
  check(await js(`${H}.querySelector('.nb-banner').textContent.includes('ipykernel')`), 'the offer names ipykernel');
  await shot('notebook-missing.png');
  if (process.env.NOTEBOOK_INSTALL === '1') {
    await click(`${HS} .nb-banner .nb-install`);
    await until(`${H}.dataset.kernel === 'idle'`, 'kernel after install', 300000);
    check(true, 'Install ipykernel installs it with pip and starts the kernel');
    await runAt(t, 0, '1 + 1', 'after install');
    check((await outputsText(t, 0)).includes('2'), 'cells run after installing ipykernel');
  }
  await js('ide.closeAllTabs(true)');
} catch (e) {
  check(false, `unexpected: ${e.message}`);
  await shot('notebook-failure.png').catch(() => {});
}
t.close();

// ---------- Korean session ----------
const k = await launch({ fixture: 'notebook', port: 9671, name: 'notebook-ko', lang: 'ko-KR' });
try {
  await k.until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(k, VENV_PY);
  await openFile(k, 'analysis.ipynb');
  await k.until(`${H}?.dataset.cells === '4'`, 'notebook (ko)');
  await k.until(`${H}.querySelector('.nb-md h1')`, 'markdown (ko)');
  k.check(await k.js(`${H}.querySelector('.nb-kernel-text').textContent`) === '커널이 시작되지 않음', 'kernel status is Korean');
  await runAt(k, 3, '1/0', 'ko error');
  k.check(await k.js(`${H}.querySelector('.nb-kernel-text').textContent.includes('유휴')`), 'kernel state Idle is Korean');
  await k.js(`${V}.select(1)`);
  const leaks = await englishLeaks(k, '.nb-host', ['Markdown']);
  k.check(!leaks.length, `no English UI text in the notebook${leaks.length ? `: ${JSON.stringify(leaks.slice(0, 8))}` : ''}`);
  await k.js('ide.closeAllTabs(true)');
  await useInterpreter(k, bareVenv());
  writeFileSync(path.join(k.project, 'fresh.ipynb'), '');
  await openFile(k, 'fresh.ipynb');
  await k.js(`${V}.runCell(0)`);
  await k.until(`${H}.dataset.kernel === 'missing'`, 'missing (ko)', 30000);
  const bannerLeaks = await englishLeaks(k, '.nb-host', ['Markdown']);
  k.check(!bannerLeaks.length, `the install offer is Korean${bannerLeaks.length ? `: ${JSON.stringify(bannerLeaks)}` : ''}`);
  k.check(await k.js(`${H}.querySelector('.nb-install').textContent`) === 'ipykernel 설치', 'install button is Korean');
  await k.shot('notebook-ko.png');
  const missing = await missingTranslations(k);
  const mine = missing.filter((s) => /cell|kernel|notebook|ipykernel|output/i.test(s));
  k.check(!mine.length, `every notebook string has Korean${mine.length ? `: ${JSON.stringify(mine)}` : ''}`);
} catch (e) {
  k.check(false, `unexpected: ${e.message}`);
  await k.shot('notebook-ko-failure.png').catch(() => {});
}
k.close();

const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
const errors = [...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
