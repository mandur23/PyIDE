// main/cut/voice.js without Electron or Python: names and keys, the temp files, the fake backend's WAV, Cancel leaving
// nothing, the found file, and the status of a real backend pointed at an empty Hugging Face cache (the model missing).
// Usage: node verify/cut-voice-core.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const results = [];
const check = (ok, name) => { results.push({ ok: !!ok, name }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-voice-core-'));
const dirs = { mediaDir: path.join(root, 'Media'), cacheDir: path.join(root, 'Cache'), tmpDir: path.join(root, 'tmp') };
const { createVoice, cleanName, fileName } = require('../main/cut/voice.js');

try {
  check(cleanName('my: talk?.mp4') === 'my_ talk_' && cleanName('') === 'sound' && cleanName('a'.repeat(90) + '.wav').length === 60, 'names lose their extension and the characters Windows refuses');
  check(fileName('talk.mp4', '0123456789abcdef') === 'talk voice 0123456789abcdef.wav', 'a vocals file is "<name> voice <key>.wav"');

  const cached = [];
  const v = createVoice({ ...dirs, onCached: (f) => cached.push(f), env: { PYIDE_VOICE_BACKEND: 'fake' } });
  check(v.status().backend === 'fake' && v.status().runtime && v.status().model.installed, 'the fake backend is ready');
  check(v.find({ name: 'x', key: 'nothex!' }).code === 'badArgs' && v.find({ name: 'x', key: '0123456789abcdef' }).missing, 'find checks the key and reports a missing file');
  const { id } = await v.open(1, { channels: 2 });
  check(!!id && v.status().open === 1, 'a temp file opens');
  check((await v.write(2, id, new Uint8Array(8))).code === 'notFound', 'another window cannot write to it');
  check((await v.write(1, id, new Uint8Array(4))).code === 'badArgs', 'a write of half a stereo frame is refused');
  const frames = 44100 * 3;
  const pcm = new Float32Array(frames * 2).map((_, i) => 0.5 * Math.sin(i / 20));
  check((await v.write(1, id, new Uint8Array(pcm.buffer))).ok, 'three seconds of stereo written');
  const r = await v.separate(1, id, { request: 'r1', name: 'talk.mp4', key: '0123456789abcdef', place: 'media', frames: frames + 44100 });
  const out = path.join(dirs.mediaDir, 'talk voice 0123456789abcdef.wav');
  check(r.ok && r.path === out && fs.existsSync(out) && !fs.existsSync(`${out}.part`), `the vocals are a WAV in the media folder, no .part left (${JSON.stringify(r)})`);
  const wav = fs.readFileSync(out);
  check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt16LE(22) === 2 && wav.readUInt32LE(24) === 44100 && wav.readUInt32LE(40) === (frames + 44100) * 4, 'a 44.1 kHz stereo 16-bit WAV padded to the frames asked for');
  check(Math.abs(wav.readInt16LE(44 + 2 * 200) / 32767 - pcm[200]) < 1e-3, 'the fake\'s vocals are the sound itself');
  check(v.find({ name: 'talk.mp4', key: '0123456789abcdef' }).path === out, 'found again by its key');
  await v.close(1, id);
  check(v.status().open === 0 && fs.readdirSync(dirs.tmpDir).length === 0, 'closing deletes the temp file');

  v.testConfig({ delay: 100 });
  const b = await v.open(1, { channels: 1 });
  await v.write(1, b.id, new Uint8Array(new Float32Array(44100 * 25).buffer));
  const job = v.separate(1, b.id, { request: 'r2', name: 'long', key: 'fedcba9876543210', place: 'cache' });
  await new Promise((res) => setTimeout(res, 300));
  v.cancel(1, 'r2');
  const c = await job;
  check(c.cancelled && fs.readdirSync(dirs.cacheDir).length === 0 && v.status().stats.cancelled === 1, 'Cancel returns cancelled and leaves no WAV or .part');
  await v.ownerGone(1);
  check(v.status().open === 0 && fs.readdirSync(dirs.tmpDir).length === 0, 'a window that goes takes its temp files');
  v.testConfig({ delay: 0 });
  const d = await v.open(1, { channels: 1 });
  await v.write(1, d.id, new Uint8Array(new Float32Array(4410).buffer));
  const e = await v.separate(1, d.id, { request: 'r3', name: 'short', key: 'aaaaaaaabbbbbbbb', place: 'cache' });
  check(e.ok && cached.includes(e.path) && path.dirname(e.path) === dirs.cacheDir, 'a vocals file in the cache is handed to the cache\'s index');
  await v.dispose();

  const empty = path.join(root, 'hf-empty');
  fs.mkdirSync(empty);
  const saved = process.env.HF_HUB_CACHE;
  process.env.HF_HUB_CACHE = empty;
  const real = createVoice({ ...dirs, env: {} });
  const st = real.status();
  check(st.backend === 'demucs' && st.model.installed === false && st.model.bytes > 0, `pointed at an empty cache, the model is missing (${JSON.stringify(st.model)})`);
  const f = await real.open(1, { channels: 1 });
  await real.write(1, f.id, new Uint8Array(new Float32Array(441).buffer));
  check((await real.separate(1, f.id, { request: 'r4', name: 'x', key: '1111111122222222' })).code === 'notInstalled', 'separating without the model says it is not installed');
  check(fs.readdirSync(empty).length === 0, 'and nothing was downloaded');
  await real.dispose();
  if (saved === undefined) delete process.env.HF_HUB_CACHE; else process.env.HF_HUB_CACHE = saved;
} catch (err) {
  check(false, err.stack || String(err));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
