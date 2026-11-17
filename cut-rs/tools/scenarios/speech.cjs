// main/cut/speech-words.js (beside the editor's modules, not under renderer/features/cut) with its samples sent as
// float32 bytes, for the Rust port's tests (crates/cut-app/tests/speech_oracle.rs).
const path = require('node:path');
const W = require(path.resolve(__dirname, '..', '..', '..', 'main', 'cut', 'speech-words.js'));

const f32 = (bytes) => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));

module.exports = {
  frameDb: (bytes) => Array.from(W.frameDb(f32(bytes))),
  refine: (bytes, words) => W.refine(f32(bytes), words),
  bursts: (bytes) => W.bursts(f32(bytes)),
  fakeWords: (bytes, opts) => W.fakeWords(f32(bytes), opts),
};
