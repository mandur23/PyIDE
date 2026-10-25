// Coalesces a child's output into fewer IPC messages. Pipes and ConPTY deliver about one read per printed line, so a
// program printing 100,000 lines would cost 100,000 messages; here a flood becomes one message per `ms` window (or per
// `max` characters). The first chunk after a quiet window goes out at once, so prompts and typing echo are not delayed.
// emit(text, key) receives the runs in arrival order; consecutive chunks with the same key (stdout, stderr) are joined.
function outputBatch(emit, { ms = 10, max = 65536 } = {}) {
  let runs = [];
  let size = 0;
  let timer = null;
  let lastSent = -Infinity;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    const pending = runs;
    runs = [];
    size = 0;
    lastSent = performance.now();
    for (const [key, text] of pending) emit(text, key);
  };
  return {
    push(text, key) {
      if (!text) return;
      const now = performance.now();
      if (!runs.length && now - lastSent >= ms) {
        lastSent = now;
        emit(text, key);
        return;
      }
      const last = runs[runs.length - 1];
      if (last && last[0] === key) last[1] += text;
      else runs.push([key, text]);
      size += text.length;
      if (size >= max) flush();
      else timer ??= setTimeout(flush, Math.max(0, ms - (now - lastSent)));
    },
    flush,
  };
}

module.exports = { outputBatch };
