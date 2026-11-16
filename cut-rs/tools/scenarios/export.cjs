// export.js's pure parts and main's faststart, with results JSON can carry: a frame plan as its numbers and frame
// times, faststart's rewriteMoov on base64 bytes with a shift map, and faststart itself on a file.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..', '..', '..');
const exp = require(path.join(root, 'renderer', 'features', 'cut', 'export.js'));
const fast = require(path.join(root, 'main', 'cut', 'faststart.js'));

const b64 = (b) => ({ $bytes: Buffer.from(b).toString('base64') });

module.exports = {
  framePlan(fps, from, to, n) {
    const p = exp.framePlan({ fps }, from, to);
    const times = [];
    for (let i = 0; i < Math.min(n, p.count); i++) times.push([p.timeOf(i), p.ptsOf(i)]);
    return { count: p.count, first: p.first, frame: p.frame, times };
  },
  chapters: (markers, firstName, range) => exp.chapters({ markers }, { firstName, range }),
  chapterProblems: (markers) => exp.chapterProblems({ markers }),
  captionsInRange: (items, range) => exp.captionsInRange(items, range),
  captionsAt: (items, t) => exp.captionsAt(items, t),
  sidecarPath: exp.sidecarPath,
  withExt: exp.withExt,
  psnr: (a, b) => exp.psnr(Uint8Array.from(a), Uint8Array.from(b)),
  // offsets below `at` stay, the others move by `by` (a shifted mdat)
  rewriteMoov(bytes, at, by) {
    try {
      return b64(fast.rewriteMoov(Buffer.from(bytes), (o) => (o < at ? o : o + by)));
    } catch (err) { return { error: String(err.message) }; }
  },
  // faststart on a copy of the file: the result and the bytes it left
  async faststart(file) {
    const r = await fast.faststart(file);
    const out = { ...r };
    delete out.path;
    if (fs.existsSync(file)) out.file = b64(fs.readFileSync(file));
    return out;
  },
};
