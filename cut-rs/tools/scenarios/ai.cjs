// The text AI's pure half (renderer/features/cut/ai.js) for the Rust port (crates/cut-app/src/ai): the checks of
// Claude's answers, the prompts and the plans, on the inputs a Rust test sends. Maps come back as [key, value] lists
// sorted by key, the parameters of describePlan as the strings tr() would put in, and projects are given as text
// (model.cjs builds them; migrated as the editor opens them) with the id of the sequence a call works on.
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const ai = require(path.join(CUT, 'ai.js'));
const model = require(path.join(CUT, 'model.js'));
const built = require('./model.cjs');

// The project as the editor holds it: migrated, as opening a file makes it.
const seqOf = (text, seqId) => {
  const p = model.migrate(text);
  return { p, seq: p.sequences.find((s) => s.id === seqId) };
};
const entries = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]);

module.exports = {
  projects: () => [...built.projects(), ...built.sampled({ seed: 20261116, steps: 600, every: 60 })],
  parseJson: (text) => ai.parseJson(text),
  retryPrompt: (p, a, e) => ai.retryPrompt(p, a, e),
  clock: (s) => ai.clock(s),
  clockFine: (s) => ai.clockFine(s),
  condense: (segments, opts) => ai.condense(segments, opts),
  polishPrompt: (lines, lang) => ai.polishPrompt(lines, { lang }).prompt,
  translatePrompt: (lines, from, to) => ai.translatePrompt(lines, { from, to }).prompt,
  system: () => ai.polishPrompt([], {}).system,
  validateLines(value, lines) {
    const r = ai.validateLines(value, lines);
    return r.error ? r : { value: entries(r.value) };
  },
  metadataPrompt: (o) => ai.metadataPrompt(o).prompt,
  fixChapters: (list, seconds, intro) => ai.fixChapters(list, seconds, { intro }),
  cleanTags: (list) => ai.cleanTags(list),
  validateMetadata: (value, duration, intro) => ai.validateMetadata(value, { duration, intro }),
  chapterText: (list) => ai.chapterText(list),
  highlightsPrompt: (o) => ai.highlightsPrompt(o).prompt,
  validateHighlights: (value, o) => ai.validateHighlights(value, o),
  complement: (keep, duration) => ai.complement(keep, duration),
  shortsEdits(text, seqId, mode) {
    const { p, seq } = seqOf(text, seqId);
    return ai.shortsEdits(p, seq, { mode });
  },
  sequenceSummary(text, seqId, selection, maxClips) {
    const { p, seq } = seqOf(text, seqId);
    return ai.sequenceSummary(p, seq, { selection, maxClips });
  },
  commandPrompt: (request, summary, transcript) => ai.commandPrompt({ request, summary, transcript }).prompt,
  validatePlan: (value, ctx) => ai.validatePlan(value, ctx),
  volumeClips(text, seqId, which, selection) {
    const { seq } = seqOf(text, seqId);
    return ai.volumeClips(seq, which, selection).map((c) => c.id);
  },
  planCommands(text, seqId, ops, selection, silence) {
    const { seq } = seqOf(text, seqId);
    return ai.planCommands(ops, { seq, selection, silence });
  },
  describePlan(text, seqId, ops, selection, silence) {
    const { seq } = seqOf(text, seqId);
    return ai.describePlan(ops, { seq, selection, silence })
      .map((l) => ({ text: l.text, params: Object.fromEntries(Object.entries(l.params).map(([k, v]) => [k, String(v)])) }));
  },
  lineBreak: (text, lang, maxChars, maxLines) => ai.lineBreak(text, lang, { maxChars, maxLines }),
  keepLines: (before, after, lang) => ai.keepLines(before, after, lang),
  cjkTokens: (text) => ai.cjkTokens(text),
  diffChars: (a, b) => ai.diffChars(a, b),
};
