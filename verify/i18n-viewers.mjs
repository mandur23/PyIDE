// Korean UI of the File Viewers plugin: no English left on its surfaces, every tr() string translated, Light theme.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(APP_DIR, 'renderer', 'features', 'viewers');

// ---------- static: every string the plugin passes to tr() has a Korean entry ----------
const src = readFileSync(path.join(DIR, 'index.js'), 'utf8');
const ko = JSON.parse(readFileSync(path.join(DIR, 'locales', 'ko.json'), 'utf8'));
const mine = new Set();
for (const m of src.matchAll(/(?<![\w.])tr\('((?:[^'\\]|\\.)*)'/g)) mine.add(m[1]);
// Model kinds are looked up through tr(MODEL_KIND[ext]).
const kinds = src.match(/const MODEL_KIND = \{([\s\S]*?)\};/)[1];
for (const m of kinds.matchAll(/: '([^']+)'/g)) mine.add(m[1]);
mine.add('Model file');
const plugin = JSON.parse(readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
mine.add(plugin.name);
mine.add(plugin.description);
const staticMissing = [...mine].filter((s) => !(s in ko));

const t = await launch({ fixture: 'viewers', port: 9481, name: 'i18n-viewers', lang: 'ko-KR' });
const { js, until, check, shot, sleep } = t;
check(!staticMissing.length, `every tr() string has a Korean entry (${staticMissing.length} missing${staticMissing.length ? `: ${staticMissing.join(' | ')}` : ''})`);

const H = 'ide.activeTab().host';
const SURFACE = '.custom-tab.vw:not(.hidden)';
// Product and format names stay in English, as in PyCharm's Korean pack.
const ALLOWED = ['safetensors', 'NumPy', 'PyTorch', 'onnx', 'ONNX', 'torch', 'Keras', 'HDF5', 'MediaPipe', 'TensorFlow', 'Lite', 'NaN', 'Inf'];
const allLeaks = [];
async function leaksFor(label) {
  const leaks = await englishLeaks(t, SURFACE, ALLOWED);
  check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  allLeaks.push(...leaks);
}

try {
  await until('ide.currentInterp()', 'interpreter', 30000);
  check(await js(`i18n.locale`) === 'ko', 'Korean session');

  await openFile(t, 'images/sample.png');
  await until(`${H}.dataset.loaded === 'true'`, 'image');
  check(await js(`[...${H}.querySelectorAll('.vw-btn')].map(b => b.title).includes('확대')`), 'image toolbar translated (확대)');
  await leaksFor('image viewer');

  await openFile(t, 'audio/tone.wav');
  await until(`${H}.dataset.loaded === 'true'`, 'audio');
  check(await js(`${H}.querySelector('.vw-info').textContent.includes('스테레오')`), 'audio info translated (스테레오)');
  await leaksFor('audio viewer');

  await openFile(t, 'video/clip.mp4');
  await until(`${H}.dataset.loaded === 'true' || ${H}.dataset.unsupported`, 'video', 20000);
  check(await js(`${H}.textContent.includes('프레임을 PNG로 저장')`), 'video toolbar translated');
  await leaksFor('video viewer');

  await openFile(t, 'arrays/cache.npz');
  await until(`${H}.dataset.loaded === 'true' || ${H}.dataset.error`, 'npz', 60000);
  check(await js(`${H}.querySelector('.vw-list-title').textContent`) === '배열 (4)', 'npz list title translated');
  await leaksFor('NumPy viewer');

  await openFile(t, 'models/tiny.safetensors');
  await until(`${H}.dataset.tensors`, 'safetensors');
  await leaksFor('safetensors viewer');
  await openFile(t, 'models/tiny.pt');
  await until(`${H}.dataset.probe`, 'torch', 120000);
  await leaksFor('PyTorch viewer');
  await openFile(t, 'models/fake.onnx');
  await until(`${H}.dataset.probe`, 'onnx', 60000);
  check(await js(`${H}.querySelector('.vw-problem').textContent.includes('설치되어 있지 않습니다') || ${H}.dataset.probe === 'error'`), 'onnx missing message translated');
  await leaksFor('ONNX viewer');

  await openFile(t, 'data/records.jsonl');
  await until(`${H}.dataset.loaded === 'true'`, 'jsonl');
  check(await js(`${H}.querySelector('.vw-row-error').textContent.includes('3행:')`), 'JSONL error row translated');
  check(await js(`${H}.querySelector('.vw-count').textContent`) === '행: 4', 'row count translated');
  await leaksFor('JSONL table');

  await openFile(t, 'data/table.csv');
  await until(`${H}.dataset.loaded === 'true'`, 'csv');
  await leaksFor('CSV table');

  await openFile(t, 'docs/README.md');
  await until(`${H}.querySelector('.vw-md-preview h1')`, 'markdown');
  check(await js(`[...${H}.querySelectorAll('.vw-seg-btn')].map(b => b.textContent).join('|')`) === '에디터|에디터 및 미리보기|미리보기', 'Markdown modes use PyCharm terms');
  await leaksFor('Markdown viewer');

  const missing = (await missingTranslations(t)).filter((s) => mine.has(s));
  check(missing.length === 0, `no missing translations from the viewers plugin${missing.length ? `: ${missing.join(' | ')}` : ''}`);
  check(allLeaks.length === 0, `englishLeaks on viewer surfaces is [] (${allLeaks.length})`);

  // ---------- Light theme: Markdown next to the CSV table ----------
  // Split first: creating a split pane re-applies the startup editor theme (a core issue, reported separately).
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'data\\\\table.csv'), { group: 'right' })`);
  await until(`ide.groups().length === 2 && ${H}.dataset.loaded === 'true'`, 'csv right', 10000);
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await sleep(400);
  check(await js(`document.documentElement.dataset.theme`) === 'light', 'Light theme applied');
  check(await js(`getComputedStyle(document.querySelector('.vw-md-preview')).backgroundColor`) === 'rgb(255, 255, 255)', 'Markdown preview follows the Light theme');
  check(await js(`getComputedStyle(document.querySelector('.vw-md-editor .monaco-editor-background')).backgroundColor`) === 'rgb(255, 255, 255)', 'embedded Markdown editor follows the Light theme');
  await shot('light-ko.png');
  await openFile(t, 'arrays/cache.npz');
  await until(`${H}.dataset.loaded === 'true'`, 'npz light', 60000);
  await sleep(200);
  await shot('light-ko-npz.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
