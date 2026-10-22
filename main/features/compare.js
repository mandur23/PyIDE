// File compare (compare plugin): whether two files that cannot be diffed as text (binary, or too large) hold the same
// bytes. Read in 1 MB slices, so comparing two large files never holds them in memory.
const fs = require('fs');

const CHUNK = 1024 * 1024;

async function sameBytes(a, b) {
  const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
  const sizes = [sa.size, sb.size];
  if (sa.size !== sb.size) return { same: false, sizes };
  const [fa, fb] = await Promise.all([fs.promises.open(a, 'r'), fs.promises.open(b, 'r')]);
  try {
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let pos = 0; pos < sa.size; pos += CHUNK) {
      const [ra, rb] = await Promise.all([fa.read(ba, 0, CHUNK, pos), fb.read(bb, 0, CHUNK, pos)]);
      if (ra.bytesRead !== rb.bytesRead || !ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return { same: false, sizes };
    }
    return { same: true, sizes };
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

exports.sameBytes = sameBytes;
exports.register = ({ ipcMain }) => {
  ipcMain.handle('compare:sameBytes', (_e, a, b) => sameBytes(String(a), String(b)));
};
