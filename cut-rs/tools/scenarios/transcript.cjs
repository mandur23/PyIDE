// The Transcript panel's Delete for the Rust port (crates/cut-app/src/speech/panel.rs): `removeSelected` of
// ui-speech.js on a project and its timeline words, with ui-auto.js's `rippleTracks` and `rippleRanges` taken out of
// their source text and run as written: the ranges, the tracks and the project after the one "Delete Words" step.
const fs = require('node:fs');
const path = require('node:path');
const take = require('./take.cjs');
const { canon } = require('./model.cjs');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const S = require(path.join(CUT, 'speech.js'));
const model = require(path.join(CUT, 'model.js'));
const C = require(path.join(CUT, 'commands.js'));
const uiAuto = fs.readFileSync(path.join(CUT, 'ui-auto.js'), 'utf8');
// eslint-disable-next-line no-new-func
const rippleTracks = new Function('model', `${take(uiAuto, 'rippleTracks')}\nreturn rippleTracks;`)(() => model);

module.exports = {
  // words: [{t0, t1, text, clip}] on the timeline (ticks); chosen: word indexes.
  deleteWords(text, seqId, words, chosen, frame) {
    const p = model.migrate(text);
    const h = C.createHistory(p);
    const seq = p.sequences.find((s) => s.id === seqId);
    const ranges = S.removalRanges(words, chosen, { frame });
    if (!ranges.length) return { ranges, tracks: null, project: null };
    const own = [...new Set(chosen.map((k) => words[k].clip))].map((id) => seq.clips.find((c) => c.id === id)).filter(Boolean);
    const { tracks } = rippleTracks(seq, own);
    h.do(C.batch('Delete Words', ranges.slice().reverse().map(([a, b]) => C.extract(seq.id, a, b, tracks))));
    return { ranges, tracks, project: canon(JSON.stringify(p)) };
  },
};
