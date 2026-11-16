// srt.js on a generated file of many captions: the file itself, and the time its parsers take on it.
const path = require('node:path');
const srt = require(path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut', 'srt.js'));

const LINES = ['안녕하세요, 오늘은 자막을 만들어 봅니다.', 'Hello <i>world</i>, this is caption', '두 번째 줄 {\\an8}위쪽', 'Tom &amp; Jerry 😀'];

// n captions of one or two lines, 2 s apart, numbered, CRLF, as an editor writes them.
function sample(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const text = i % 3 ? LINES[i % LINES.length] : `${LINES[i % LINES.length]}\n${LINES[(i + 1) % LINES.length]}`;
    items.push({ start: i * 2 * 254016000000, end: (i * 2 + 1.5) * 254016000000, text });
  }
  return srt.write(items);
}

// Nanoseconds per caption of parse (or parseVtt on the VTT form), the best of `reps` runs after a warm-up.
function bench(n, reps, vtt = false) {
  const text = vtt ? srt.writeVtt(srt.parse(sample(n))) : sample(n);
  const run = vtt ? srt.parseVtt : srt.parse;
  let count = 0;
  for (let i = 0; i < 3; i++) count += run(text).length;
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    count += run(text).length;
    best = Math.min(best, Number(process.hrtime.bigint() - t0));
  }
  return { nsPerCaption: best / n, count };
}

const api = { ...srt, sample, bench };
// The oracle decodes stdin chunk by chunk, so a character split between chunks is lost: a test sends each call's
// arguments as an ASCII JSON text.
module.exports = { ...api, ascii: (fn, args) => api[fn](...JSON.parse(args)) };
