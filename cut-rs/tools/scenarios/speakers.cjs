// Speaker labels and voice isolation for the Rust port (crates/cut-app/src/speakers, src/voice): speakers.js as it is,
// with its Map arguments and results as lists of pairs, the fake backends' embedding (main/cut/speakers.js) and WAV
// header (main/cut/voice.js), the vocals' file names, and the cache keys of ui-speakers.js and ui-voice.js, which are
// panels: those functions are taken out of their source text by name and run here exactly as written.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CUT = path.join(ROOT, 'renderer', 'features', 'cut');
const K = require(path.join(CUT, 'speakers.js'));
const mainSpeakers = require(path.join(ROOT, 'main', 'cut', 'speakers.js'));
const mainVoice = require(path.join(ROOT, 'main', 'cut', 'voice.js'));

const take = require('./take.cjs');

const uiSpeakers = fs.readFileSync(path.join(CUT, 'ui-speakers.js'), 'utf8');
const uiVoice = fs.readFileSync(path.join(CUT, 'ui-voice.js'), 'utf8');
const mainVoiceText = fs.readFileSync(path.join(ROOT, 'main', 'cut', 'voice.js'), 'utf8');
// eslint-disable-next-line no-new-func
const spk = new Function(`${take(uiSpeakers, 'fnv')}\n${take(uiSpeakers, 'keyOf')}\nreturn { fnv, keyOf };`)();
// eslint-disable-next-line no-new-func
const voice = new Function('T', `${take(uiVoice, 'hash')}\n${take(uiVoice, 'round3')}\n${take(uiVoice, 'keyOf')}\nreturn { hash, keyOf };`)(254016000000);
// eslint-disable-next-line no-new-func
const wavHeader = new Function('Buffer', 'RATE', `${take(mainVoiceText, 'wavHeader')}\nreturn wavHeader;`)(Buffer, mainVoice.RATE);

module.exports = {
  ...K,
  match: (oldTurns, newTurns, ids) => [...K.match(oldTurns, newTurns, ids)],
  listFor: (count, list, pairs, taken) => K.listFor(count, { list }, new Map(pairs), taken),
  fakeEmbedding: (x) => Array.from(mainSpeakers.fakeEmbedding(Float32Array.from(x))),
  speakersKey: (m, windows) => spk.keyOf(m, windows),
  voiceKey: (m, from, to) => voice.keyOf(m, from, to),
  cleanName: mainVoice.cleanName,
  fileName: mainVoice.fileName,
  wavHeader: (frames, channels) => [...wavHeader(frames, channels)],
};
