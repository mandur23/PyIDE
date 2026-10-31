// End-to-end check for the File Viewers plugin (renderer/features/viewers, main/features/viewers.js).
// Fixtures: verify/fixtures/viewers (binary files come from make_fixtures.py there).
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, SANITIZED_HANDLER } from './lib.mjs';

const PORT = 9480;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'viewers');
const t = await launch({ fixture: 'viewers', port: PORT });
const { js, until, press, type, check, shot, cdp, sleep } = t;

const H = 'ide.activeTab().host';
const ds = (k) => js(`${H}.dataset.${k}`);
const mouse = async (x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) => {
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x, y, button, clickCount, modifiers });
  await sleep(80);
};
const centerOf = (expr) => js(`(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left }; })()`);
async function clickEl(expr, opts) {
  const c = await centerOf(expr);
  if (!c) throw new Error(`no element: ${expr}`);
  await mouse(c.x, c.y, opts);
}
async function tabMenu(fileName, label) {
  await clickEl(`[...document.querySelectorAll('.tab')].find(n => n.dataset.path.endsWith(${JSON.stringify(fileName)}))`, { button: 'right' });
  await until(`[...document.querySelectorAll('.menu-item')].some(n => n.textContent.startsWith(${JSON.stringify(label)}))`, `menu ${label}`);
  await clickEl(`[...document.querySelectorAll('.menu-item')].find(n => n.textContent.startsWith(${JSON.stringify(label)}))`);
}
const loaded = (label) => until(`${H}?.dataset.loaded === 'true'`, `${label} loaded`, 30000);
// Non-background pixels on a canvas.
const inkOf = (canvasExpr) => js(`(() => {
  const c = ${canvasExpr}; const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
  const bg = [d[0], d[1], d[2]]; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) n++;
  return n;
})()`);

try {
  await until('ide.currentInterp()', 'interpreter detected', 30000);

  // ---------- image ----------
  await openFile(t, 'images/sample.png');
  await loaded('image');
  check(await ds('width') === '64' && await ds('height') === '48', 'image dimensions 64x48 read from the file');
  check(await js(`${H}.querySelector('.vw-dims').textContent === '64 × 48'`), 'info bar shows dimensions');
  await until(`/KB|B$/.test(${H}.querySelector('.vw-size').textContent)`, 'file size in info bar');
  check(true, 'info bar shows file size');
  check(await js(`${H}.querySelector('.vw-zoom').textContent === '100%'`), 'small image opens at 100%');
  check(await js(`getComputedStyle(${H}.querySelector('.vw-img-box')).backgroundImage.includes('conic-gradient')`), 'checkerboard behind the image');
  const stage = await centerOf(`${H}.querySelector('.vw-stage')`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stage.x, y: stage.y, deltaX: 0, deltaY: -240, modifiers: 2 });
  await until(`Number(${H}.dataset.zoom) > 1.2`, 'ctrl+wheel zoom in');
  check(true, 'Ctrl+wheel zooms in');
  const before = await js(`${H}.querySelector('.vw-img-box').style.transform`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 40, y: stage.y + 25, button: 'left' });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 40, y: stage.y + 25, button: 'left', clickCount: 1 });
  check(await js(`${H}.querySelector('.vw-img-box').style.transform`) !== before, 'dragging pans the image');
  await clickEl(`[...${H}.querySelectorAll('.vw-btn')].find(b => b.textContent === 'Fit')`);
  check(Number(await ds('zoom')) > 3, 'Fit zooms the image to the pane');
  await clickEl(`[...${H}.querySelectorAll('.vw-btn')].find(b => b.textContent === '1:1')`);
  check(Number(await ds('zoom')) === 1, '1:1 returns to actual size');
  await shot('image.png');

  // ---------- audio ----------
  await openFile(t, 'audio/tone.wav');
  await loaded('audio');
  check(await ds('sampleRate') === '22050', 'audio sample rate from the WAV header');
  check(await ds('channels') === '2', 'audio channel count');
  check(Math.abs(Number(await ds('duration')) - 1) < 0.01, 'audio duration 1s');
  check(await js(`${H}.querySelector('.vw-info').textContent.includes('22,050 Hz')`), 'info shows sample rate');
  check(await inkOf(`${H}.querySelector('canvas.vw-wave')`) > 500, 'waveform canvas is drawn');
  const wave = await centerOf(`${H}.querySelector('.vw-wave-stage')`);
  await mouse(wave.x, wave.y);
  check(Math.abs(Number(await ds('seeked')) - 0.5) < 0.05, 'clicking the waveform seeks to the middle');
  await until(`${H}.querySelector('.vw-readout').textContent.match(/^0:00\.(4[5-9]|5[0-5])/)`, 'readout after seek', 5000).then(() => check(true, 'current time readout follows the seek'), () => check(false, 'current time readout follows the seek'));
  await clickEl(`${H}.querySelector('.vw-play')`);
  await until(`${H}.querySelector('.vw-play').textContent === '⏸'`, 'playing', 5000).then(() => check(true, 'play button starts playback'), () => check(false, 'play button starts playback'));
  await clickEl(`${H}.querySelector('.vw-play')`);
  await shot('audio.png');

  // 2.5 hours of 8 kHz mono: decoding at 8 kHz would take 288 MB of samples, so it decodes at a lower rate.
  const seconds = 9000;
  const wav = Buffer.alloc(44 + seconds * 8000, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(seconds * 8000, 40);
  writeFileSync(path.join(t.project, 'audio', 'long.wav'), wav);
  await openFile(t, 'audio/long.wav');
  await loaded('long audio');
  check(Number(await ds('decodeRate')) < 8000 && await ds('sampleRate') === '8000' && Math.abs(Number(await ds('duration')) - seconds) < 1,
    `a long recording decodes at a lower rate for its waveform (${await ds('decodeRate')} Hz; header ${await ds('sampleRate')} Hz, ${await ds('duration')} s)`);
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---------- video ----------
  if (existsSync(path.join(FIX, 'video', 'clip.mp4'))) {
    await openFile(t, 'video/clip.mp4');
    await until(`${H}?.dataset.loaded === 'true' || ${H}?.dataset.unsupported === 'true'`, 'video loaded', 20000);
    check(await ds('loaded') === 'true', 'H.264 mp4 plays in the video viewer');
    check(await js(`${H}.querySelector('.vw-dims').textContent === '160 × 120'`), 'video dimensions shown');
    await js(`${H}.focus()`);
    for (let i = 0; i < 3; i++) await press('.');
    await until(`${H}.dataset.frame === '3'`, 'frame 3', 5000);
    check(true, '"." steps forward one frame at a time');
    await press(',');
    await until(`${H}.dataset.frame === '2'`, 'frame 2', 5000);
    await until(`${H}.querySelector('.vw-readout').textContent.includes('2 / 60')`, 'frame readout', 5000);
    check(true, '"," steps back and the readout shows frame 2 / 60');
    await js(`(() => { const s = ${H}.querySelector('select.vw-select'); s.value = '2'; s.dispatchEvent(new Event('change')); return true; })()`);
    check(await js(`${H}.querySelector('video').playbackRate === 2`), 'playback speed control');
    await clickEl(`[...${H}.querySelectorAll('.vw-btn')].find(b => b.textContent === 'Save Frame as PNG')`);
    await until(`${H}.dataset.savedFrame`, 'frame saved', 10000);
    const saved = await ds('savedFrame');
    check(/clip_frame_2\.png$/.test(saved) && existsSync(saved), `frame saved next to the video (${path.basename(saved)})`);
    check(readFileSync(saved).subarray(1, 4).toString() === 'PNG', 'saved frame is a PNG');
    await shot('video.png');
  } else check(true, 'video skipped: no clip.mp4 fixture (make_fixtures.py found no ffmpeg)');

  if (existsSync(path.join(FIX, 'video', 'voice.webm'))) {
    await openFile(t, 'video/voice.webm');
    await until(`${H}.classList.contains('vw-audio') && ${H}.dataset.loaded === 'true'`, 'audio-only webm as waveform', 20000);
    check(await inkOf(`${H}.querySelector('canvas.vw-wave')`) > 200, 'audio-only WebM opens as a waveform');
  }

  // ---------- NumPy ----------
  await openFile(t, 'arrays/single.npy');
  await until(`${H}.dataset.loaded === 'true' || ${H}.dataset.error`, 'npy probe', 60000);
  check(await ds('loaded') === 'true', '.npy loads with the selected interpreter');
  const npy = await js(`${H}.querySelector('.vw-np-detail').textContent`);
  check(npy.includes('(3, 4)') && npy.includes('float32'), 'npy shape and dtype');
  check(await js(`[...${H}.querySelectorAll('.vw-stat')].map(s => s.textContent).join('|')`) === 'Min0|Max5.5|Mean2.75|Std1.72603', 'npy min/max/mean/std');
  check(await js(`${H}.querySelectorAll('.vw-table tbody tr').length`) === 3, 'npy first rows as a table');

  await openFile(t, 'arrays/cache.npz');
  await until(`${H}.dataset.loaded === 'true' || ${H}.dataset.error`, 'npz probe', 60000);
  const names = await js(`[...${H}.querySelectorAll('.vw-np-item-name')].map(n => n.textContent)`);
  check(JSON.stringify(names) === JSON.stringify(['features', 'labels', 'mask', 'cube']), `npz array list (${names})`);
  await clickEl(`[...${H}.querySelectorAll('.vw-np-item')].find(n => n.textContent.startsWith('labels'))`);
  check(await js(`${H}.querySelector('.vw-np-name').textContent`) === 'labels', 'selecting an npz array shows its details');
  check(await js(`[...${H}.querySelectorAll('.vw-stat')].map(s => s.textContent).join('|')`) === 'Min0|Max9|Mean4.5|Std2.87228', 'npz array stats');
  await clickEl(`[...${H}.querySelectorAll('.vw-np-item')].find(n => n.textContent.startsWith('cube'))`);
  check(await js(`${H}.querySelector('.vw-np-detail').textContent.includes('[0, :, :]')`), '3-D arrays show a 2-D slice');
  await shot('npz.png');

  // ---------- models ----------
  await openFile(t, 'models/tiny.safetensors');
  await until(`${H}.dataset.tensors`, 'safetensors header', 10000);
  check(await ds('tensors') === '4', 'safetensors header lists 4 tensors');
  const st = await js(`${H}.querySelector('.vw-tensor-table').textContent`);
  check(st.includes('encoder.weight') && st.includes('F32') && st.includes('(4, 3)') && st.includes('F16'), 'tensor table: names, dtypes, shapes');
  check(await js(`${H}.querySelector('.vw-params').textContent`) === '25', 'total parameter count');
  check(await js(`${H}.querySelector('.vw-meta').textContent.includes('PyIDE fixture')`), 'safetensors metadata');
  await clickEl(`${H}.querySelector('.vw-copy-path')`);
  await until(`${H}.querySelector('.vw-actions .vw-status').textContent === 'Copied'`, 'copied', 3000);
  check(true, 'Copy Path button');
  await shot('safetensors.png');

  if (existsSync(path.join(FIX, 'models', 'tiny.pt'))) {
    await openFile(t, 'models/tiny.pt');
    await until(`${H}.dataset.probe`, 'torch probe', 120000);
    const probe = await ds('probe');
    if (probe === 'missing') check(true, 'torch not installed: size only');
    else {
      check(probe === 'ok' && await ds('tensors') === '3', 'torch.load(weights_only) lists state_dict tensors');
      const txt = await js(`${H}.textContent`);
      check(txt.includes('state_dict.conv.weight') && txt.includes('(8, 3, 3, 3)') && txt.includes('epoch'), 'state_dict keys, shapes and other entries');
    }
  }
  await openFile(t, 'models/fake.onnx');
  await until(`${H}.dataset.probe`, 'onnx probe', 60000);
  check(['missing', 'error'].includes(await ds('probe')) && await js(`${H}.querySelector('.vw-problem') !== null`), 'onnx: clear message when onnx is missing or the file is not a model');
  check(await js(`${H}.querySelector('.vw-card').textContent.includes('17 B')`), 'model card shows the size');

  // ---------- Markdown ----------
  await openFile(t, 'docs/README.md');
  await until(`${H}.querySelector('.vw-md-preview h1')`, 'markdown preview', 15000);
  check(await ds('mode') === 'split', 'Markdown opens as Editor and Preview');
  check(await js(`${H}.querySelector('.vw-md-preview h1').textContent`) === '음성 변환 프로젝트', 'Korean heading renders');
  check(await js(`${H}.querySelectorAll('.vw-md-preview table td').length`) === 4, 'GFM table renders');
  await until(`${H}.querySelector('.vw-md-preview img[alt="샘플 이미지"]')?.naturalWidth === 64`, 'relative image', 5000);
  check(true, 'relative image resolves against the file folder');
  check(await js(`!document.querySelector('.vw-md-preview script') && !window.__mdInjected && ![...document.querySelectorAll('.vw-md-preview *')].some(n => [...n.attributes].some(a => a.name.startsWith('on')))`), 'scripts and on* attributes are stripped');
  check(await js(`[...${H}.querySelectorAll('.vw-md-preview a')].find(a => a.textContent === '위험한 링크').hasAttribute('href') === false`), 'javascript: links are removed');
  check(await js(`[...${H}.querySelectorAll('.vw-md-preview a')].find(a => a.textContent === '공식 문서').getAttribute('href') === 'https://example.com/docs'`), 'http(s) links are kept');
  await until(`${H}.querySelector('.vw-md-preview pre code span[class^="mtk"]')`, 'code colorized', 5000).then(() => check(true, 'fenced code is syntax highlighted'), () => check(false, 'fenced code is syntax highlighted'));
  const renders = Number(await ds('renders'));
  await js(`(() => { const ed = ${H}._viewer.editor; const m = ed.getModel(); const end = m.getFullModelRange().getEndPosition(); ed.focus(); ed.setPosition(end); return true; })()`);
  await type('\n## 새 섹션 추가\n');
  await until(`[...${H}.querySelectorAll('.vw-md-preview h2')].some(h => h.textContent === '새 섹션 추가')`, 'live preview', 5000);
  check(Number(await ds('renders')) > renders, 'preview updates live after typing in the embedded editor');
  await until(`ide.isDirty(ide.activeTab())`, 'dirty', 3000).then(() => check(true, 'editing marks the tab modified'), () => check(false, 'editing marks the tab modified'));
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab.active .dirty')`, 'saved', 5000);
  const mdPath = await js(`${H.replace('.host', '.path')}`);
  check((await js(`ide.api.read(${JSON.stringify(mdPath)})`)).includes('## 새 섹션 추가'), 'Ctrl+S saves the Markdown file');
  await js(`(() => { const ed = ${H}._viewer.editor; ed.setScrollTop(ed.getScrollHeight()); return true; })()`);
  await until(`${H}.querySelector('.vw-md-preview').scrollTop > 0`, 'scroll sync', 3000).then(() => check(true, 'editor scrolling scrolls the preview'), () => check(false, 'editor scrolling scrolls the preview'));
  await shot('markdown.png');
  await clickEl(`${H}.querySelector('.vw-seg-btn[data-value="preview"]')`);
  check(await js(`${H}.querySelector('.vw-md-editor').classList.contains('hidden') && !${H}.querySelector('.vw-md-preview').classList.contains('hidden')`), 'Preview mode hides the editor');
  await clickEl(`${H}.querySelector('.vw-seg-btn[data-value="editor"]')`);
  check(await js(`${H}.querySelector('.vw-md-preview').classList.contains('hidden')`), 'Editor mode hides the preview');
  await clickEl(`${H}.querySelector('.vw-seg-btn[data-value="split"]')`);
  await js(`[...${H}.querySelectorAll('.vw-md-preview a')].find(a => a.textContent === '데이터 설명').scrollIntoView({ block: 'center' })`);
  await sleep(150);
  await clickEl(`[...${H}.querySelectorAll('.vw-md-preview a')].find(a => a.textContent === '데이터 설명')`);
  await until(`ide.activeTab()?.path.endsWith('table.csv')`, 'relative link opens file', 5000);
  check(true, 'relative Markdown links open the file in the IDE');

  // ---------- CSV ----------
  await loaded('csv');
  check(await ds('mode') === 'table', 'CSV opens as a table');
  check(await ds('rows') === '6', 'CSV rows (quoted newline kept in one record)');
  const heads = await js(`[...${H}.querySelectorAll('.vw-th-name')].map(n => n.textContent)`);
  check(JSON.stringify(heads) === JSON.stringify(['id', 'name', 'city', 'score', 'note']), 'header row');
  check(await js(`[...${H}.querySelectorAll('.vw-row .vw-cell')].some(c => c.textContent === 'Seoul, KR')`), 'quoted commas stay in one field');
  check(await js(`[...${H}.querySelectorAll('.vw-row .vw-cell')].some(c => c.textContent === 'says "hi"')`), 'escaped quotes');
  const firstScore = () => js(`[...${H}.querySelectorAll('.vw-row')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))[0].children[4].textContent`);
  await clickEl(`[...${H}.querySelectorAll('.vw-th')].find(n => n.textContent.startsWith('score'))`);
  check(await firstScore() === '9', 'sort ascending (numeric)');
  await clickEl(`[...${H}.querySelectorAll('.vw-th')].find(n => n.textContent.startsWith('score'))`);
  check(await firstScore() === '100', 'sort descending');
  await js(`(() => { const s = ${H}.querySelector('.vw-filter-col'); s.value = '2'; s.dispatchEvent(new Event('change')); return true; })()`);
  await clickEl(`${H}.querySelector('.vw-filter')`);
  await type('KR');
  await until(`${H}.dataset.shown === '3'`, 'filter', 3000);
  check(await js(`${H}.querySelector('.vw-count').textContent`) === 'Rows: 3 of 6', 'column filter and row count');
  await shot('csv.png');
  await clickEl(`${H}.querySelector('.vw-seg-btn[data-value="editor"]')`);
  check(await js(`!!${H}._viewer.editor && !${H}.querySelector('.vw-tv-editor').classList.contains('hidden')`), 'Editor / Table toggle shows the embedded editor');
  await clickEl(`${H}.querySelector('.vw-seg-btn[data-value="table"]')`);

  // 50k rows: only the visible window is in the DOM.
  const big = await js(`ide.util.joinPath(ide.root, 'data\\\\big.csv')`);
  await js(`ide.api.write(${JSON.stringify(big)}, 'id,label,value\\n' + Array.from({ length: 50000 }, (_, i) => i + ',"row, ' + i + '",' + (i * 0.5)).join('\\n'))`);
  await js(`ide.openFile(${JSON.stringify(big)})`);
  await until(`ide.activeTab()?.path.endsWith('big.csv') && ${H}.dataset.loaded === 'true'`, 'big csv', 20000);
  check(await ds('rows') === '50000', '50k-row CSV parsed');
  check(await js(`${H}.querySelectorAll('.vw-row').length`) < 150, `only visible rows are rendered (${await js(`${H}.querySelectorAll('.vw-row').length`)} in DOM, parse ${await ds('parseMs')} ms)`);
  await js(`(() => { const g = ${H}.querySelector('.vw-grid'); g.scrollTop = g.scrollHeight; return true; })()`);
  await until(`[...${H}.querySelectorAll('.vw-row .vw-cell')].some(c => c.textContent === 'row, 49999')`, 'last row', 5000).catch(async (e) => { console.log(await js(`[${H}.querySelector('.vw-grid').scrollTop, ${H}.querySelector('.vw-grid').scrollHeight, ${H}.querySelectorAll('.vw-row').length, [...${H}.querySelectorAll('.vw-row')].slice(-1).map(r => r.textContent)[0]]`)); throw e; });
  check(true, 'scrolling to the end renders the last row');
  check(await js(`${H}.querySelector('.vw-grid-head').getBoundingClientRect().top === ${H}.querySelector('.vw-grid').getBoundingClientRect().top`), 'header stays sticky while scrolled');
  await js(`ide.closeTab(${JSON.stringify(big)}, true)`);

  // Past the editor's 20 MB the table is read-only, and past 32 MB it shows the file's first 32 MB, cut at a line end.
  const huge = path.join(t.project, 'data', 'huge.csv');
  const lines = Array.from({ length: 40000 }, (_, i) => `${i},${'x'.repeat(990)}\n`);
  writeFileSync(huge, `id,text\n${lines.join('')}`);
  let fit = 0;
  for (let bytes = 8; fit < lines.length && bytes + lines[fit].length <= 32 * 1024 * 1024; fit++) bytes += lines[fit].length;
  await openFile(t, 'data/huge.csv');
  await until(`${H}?.dataset.loaded === 'true'`, 'huge csv', 60000);
  const hugeStatus = await js(`${H}.querySelector('.vw-status').textContent`);
  check(await ds('rows') === String(fit) && /first 32\.0 MB of 38\.0 MB/.test(hugeStatus),
    `a 38 MB CSV shows the whole lines in its first 32 MB and says so (${await ds('rows')} of ${lines.length} rows, ${fit} expected; ${hugeStatus})`);
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---------- JSONL ----------
  await openFile(t, 'data/records.jsonl');
  await loaded('jsonl');
  check(await ds('rows') === '4' && await ds('errors') === '1', 'JSONL: 4 lines, 1 parse error');
  const cols = await js(`[...${H}.querySelectorAll('.vw-th-name')].map(n => n.textContent)`);
  check(JSON.stringify(cols) === JSON.stringify(['id', 'text', 'speaker', 'duration', 'tags', 'meta']), `top-level keys as columns (${cols})`);
  check(await js(`${H}.querySelector('.vw-row-error')?.textContent.startsWith('3Line 3:')`), 'parse error row for line 3');
  check(await js(`[...${H}.querySelectorAll('.vw-row .vw-cell')].some(c => c.textContent === '{"snr":30}')`), 'nested values shown as JSON');
  await shot('jsonl.png');

  // ---------- split panes: two viewers at once ----------
  await js('ide.closeAllTabs(true)');
  await openFile(t, 'images/sample.png');
  await loaded('image again');
  await openFile(t, 'audio/tone.wav');
  await loaded('audio again');
  await tabMenu('tone.wav', 'Split Right');
  await until(`ide.groups().length === 2`, 'two groups', 5000);
  const vis = await js(`ide.groups().map(g => { const h = g.active?.host; return h && !h.classList.contains('hidden') && h.getClientRects().length > 0 ? g.active.viewer.id : null; })`);
  check(JSON.stringify(vis) === JSON.stringify(['image', 'audio']), `image and audio viewers visible side by side (${vis})`);
  await sleep(300);
  check(await inkOf(`ide.groups()[1].active.host.querySelector('canvas.vw-wave')`) > 500, 'waveform redrawn after moving to the right pane');
  check(await js(`ide.groups()[0].active.host.dataset.loaded === 'true' && ide.groups()[0].active.host.querySelector('.vw-img').complete`), 'image still shown in the left pane');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'docs\\\\README.md'))`);
  await until(`ide.activeTab()?.path.endsWith('README.md') && ide.activeTab().host.querySelector('.vw-md-preview h1')`, 'md in split', 10000);
  check(true, 'Markdown viewer opens next to the other viewers');
  await shot('split.png');

  // ---------- Open as Text ----------
  await tabMenu('README.md', 'Open as Text');
  await until(`ide.activeTab()?.kind === 'file' && ide.activeTab().path.endsWith('README.md')`, 'text tab', 5000);
  check(await js(`ide.editor.getModel().getValue().includes('새 섹션 추가')`), '"Open as Text" opens the plain text editor on the same document');

  // ---------- detached window ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'arrays\\\\cache.npz'), { group: 'window' })`);
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((p) => p.type === 'page' && p.url.includes('detached'));
  }
  if (!page) check(false, 'detached window opened');
  else {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const call = (expr) => new Promise((resolve) => {
      const my = ++id;
      const onMsg = (m) => { const msg = JSON.parse(m.data); if (msg.id === my) { ws.removeEventListener('message', onMsg); resolve(msg.result?.result?.value); } };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } }));
    });
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) {
      await sleep(500);
      ok = await call(`window.__ideReady && ide.activeTab()?.host?.dataset.loaded === 'true' && ide.activeTab().host.querySelectorAll('.vw-np-item').length === 4`).catch(() => false);
    }
    check(ok, 'npz viewer works in a detached window');
    ws.close();
  }

  // ---------- light theme ----------
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await openFile(t, 'audio/tone.wav');
  await loaded('audio light');
  await sleep(200);
  const bgPix = await js(`(() => { const c = ${H}.querySelector('canvas.vw-wave'); const d = c.getContext('2d').getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
  check(bgPix.every((v) => v > 240), `waveform uses the light background (${bgPix})`);
  await shot('light.png');
  await js(`ide.settings.set('appearance.theme', 'dark')`);

  // ---------- Markdown sanitizer: an allowlist that keeps ordinary documents whole ----------
  writeFileSync(path.join(t.project, 'docs', 'hostile.md'), `# Allowed

| a | b |
| - | - |
| 1 | 2 |

- [x] done
- [ ] open

\`\`\`python
print(1)
\`\`\`

[site](https://example.com/x) [table](../data/table.csv) [anchor](#allowed)

![pic](../images/sample.png)

<details open><summary>more</summary>inside</details>

<svg id="svgUse"><use href="other.svg#x"></use><a xlink:href="javascript:window.__mdInjected = 1"><text>t</text></a><animate attributeName="href" to="javascript:1"/></svg>
<math id="mathNode"><mtext>m</mtext></math>
<style>body { display: none; }</style>
<form action="https://example.com/"><button>go</button></form>
<iframe srcdoc="<script>parent.__mdInjected = 1</script>"></iframe>
<a id="ctlLink" href="java&#10;script:window.__mdInjected = 1">control character link</a>
<a id="dataLink" href="data:text/html,x">data link</a>
<img id="bigImg" src="../images/sample.png" onerror="window.__mdInjected = 1" style="position: fixed" class="x" srcset="other.png 1x">
<div id="styled" style="position: fixed" class="monaco-editor" data-x="1">styled</div>
<video id="clip" src="clip.mp4" controls onplay="window.__mdInjected = 1"></video>
<section>unwrapped text</section>
`);
  await openFile(t, 'docs/hostile.md');
  const P = `${H}.querySelector('.vw-md-preview')`;
  await until(`${P}?.querySelector('#styled')`, 'hostile markdown preview', 15000);
  check(await js(`!${P}.querySelector('svg, use, math, style, form, button, iframe, animate')`), 'svg, math, style, form and iframe are dropped');
  check(await js(`window.__mdInjected === undefined`), 'nothing in the document ran');
  check(await js(`!${P}.querySelector('#ctlLink').hasAttribute('href') && !${P}.querySelector('#dataLink').hasAttribute('href') && ${P}.querySelector('#ctlLink').classList.contains('vw-md-dead-link')`), 'links with a control character in the scheme and data: links lose their href');
  const attrs = (id) => js(`[...${P}.querySelector('#${id}').attributes].map((a) => a.name).filter((n) => n !== 'data-line').sort().join()`);
  check(await attrs('bigImg') === 'id,src' && await js(`${P}.querySelector('#bigImg').src.startsWith('file:')`), `an image keeps its source and no handler, style, class or srcset (${await attrs('bigImg')})`);
  check(await attrs('styled') === 'id', `a div keeps no style, class or data attribute of its own (${await attrs('styled')})`);
  check(await js(`${P}.textContent.includes('unwrapped text') && !${P}.querySelector('section')`), 'an element outside the list is unwrapped, its text stays');
  check(await js(`${P}.querySelector('#clip').hasAttribute('controls') && !${P}.querySelector('#clip').hasAttribute('onplay')`), 'video keeps its controls');
  check(await js(`${P}.querySelectorAll('table td').length`) === 2, 'tables render');
  await until(`${P}.querySelector('pre code span[class^="mtk"]')`, 'fence colorized', 5000).then(() => check(true, 'fenced code keeps its language and is highlighted'), () => check(false, 'fenced code keeps its language and is highlighted'));
  check(await js(`(() => { const b = [...${P}.querySelectorAll('li input[type="checkbox"]')]; return b.length === 2 && b.every((x) => x.disabled) && b[0].checked && !b[1].checked; })()`), 'task lists show disabled checkboxes');
  check(await js(`[...${P}.querySelectorAll('a')].filter((a) => a.getAttribute('href')).map((a) => a.getAttribute('href')).join()`) === 'https://example.com/x,../data/table.csv,#allowed', 'http, relative and anchor links stay');
  await until(`${P}.querySelector('img[alt="pic"]')?.naturalWidth === 64`, 'relative image', 5000);
  check(await js(`${P}.querySelector('details').open && ${P}.querySelector('h1').id === 'allowed'`), 'details and heading anchors stay');

  // ---------- HTML preview: what a page can read and send ----------
  const SECRET = 'hidden-value-7f3a';
  const received = [];
  const server = createServer((req, res) => { received.push(`${req.method} ${req.url}`); res.setHeader('access-control-allow-origin', '*'); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const remote = `http://127.0.0.1:${server.address().port}`;
  const site = path.join(t.project, 'site');
  mkdirSync(path.join(site, '.private'), { recursive: true });
  writeFileSync(path.join(site, '.env'), `KEY=${SECRET}\n`);
  writeFileSync(path.join(site, '.private', 'note.txt'), SECRET);
  writeFileSync(path.join(site, 'config.json'), '{"ok":true}\n');
  execSync(`mklink /J "${path.join(site, 'door')}" "${path.join(site, '.private')}"`, { shell: 'cmd.exe', stdio: 'ignore' });
  writeFileSync(path.join(site, 'probe.html'), `<!doctype html><script>
addEventListener('message', async (e) => {
  const read = async (u) => { try { const r = await fetch(u); return { status: r.status, text: await r.text() }; } catch { return { status: 'blocked', text: '' }; } };
  const send = async () => {
    const tried = [];
    for (const go of [() => fetch(e.data.remote + '/fetch', { method: 'POST', body: 'x', mode: 'no-cors' }), () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('POST', e.data.remote + '/xhr'); x.onload = res; x.onerror = rej; x.send('x'); })]) {
      tried.push(await go().then(() => 'sent', () => 'blocked'));
    }
    tried.push(navigator.sendBeacon(e.data.remote + '/beacon', 'x') ? 'queued' : 'blocked');
    return tried;
  };
  parent.postMessage({ previewProbe: true, reads: await Promise.all(e.data.reads.map(read)), sent: await send() }, '*');
});
parent.postMessage({ previewProbe: true, ready: true }, '*');
</script>\n`);
  const probePage = await js(`ide.api.invoke('viewers:previewUrl', ${JSON.stringify(path.join(site, 'probe.html'))}, ide.root)`);
  check(probePage.scripts === true, "a trusted project's pages may run scripts");
  const shortLine = /(\S+~\S*)\s+\.env\s*$/m.exec(execSync(`dir /x /a "${site}"`, { shell: 'cmd.exe', encoding: 'latin1' }));
  const short = shortLine?.[1];
  const reads = ['config.json', '.env', '.private/note.txt', 'door/note.txt', './config.json::$DATA', '.env::$DATA', ...(short ? [short, `${short}::$DATA`, `${short}.`] : [])];
  const probed = await js(`new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.display = 'none';
    const on = (e) => {
      if (e.source !== f.contentWindow || !e.data?.previewProbe) return;
      if (e.data.ready) return e.source.postMessage({ remote: ${JSON.stringify(remote)}, reads: ${JSON.stringify(reads)} }, '*');
      removeEventListener('message', on); f.remove(); resolve(e.data);
    };
    addEventListener('message', on);
    f.src = ${JSON.stringify(probePage.url)};
    document.body.appendChild(f);
  })`);
  const got = Object.fromEntries(reads.map((r, i) => [r, probed.reads[i]]));
  check(got['config.json'].status === 200 && got['config.json'].text.includes('ok'), 'a page reads its own site');
  console.log(short ? `note: .env has the short name ${short} here` : 'note: this volume makes no short names, so ENV~1 is not tried');
  const leaked = reads.slice(1).filter((r) => got[r].status === 200 || got[r].text.includes(SECRET));
  check(!leaked.length && reads.slice(1).every((r) => got[r].status === 404 || got[r].status === 'blocked'), `hidden names, a short name, a junction and NTFS streams are refused (${JSON.stringify(reads.slice(1).map((r) => [r, got[r].status]))})`);
  await sleep(500);
  check(!received.length && probed.sent.slice(0, 2).every((s) => s === 'blocked'), `a page cannot send data out (${JSON.stringify(probed.sent)}; server saw ${JSON.stringify(received)})`);
  server.close();
  await sleep(200);
  check(t.takeCsp(SANITIZED_HANDLER) > 0, 'the page policy reports the on* attributes of the Markdown documents where the sanitizer read them');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
