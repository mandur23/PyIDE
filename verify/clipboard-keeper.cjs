// Saves and restores the system clipboard around a test run (verify/lib.mjs). Test windows run on a hidden desktop
// but share the user's clipboard, and suites copy, cut and Copy Path for real. Run as an Electron main script, with no
// window: electron.exe verify/clipboard-keeper.cjs --user-data-dir=<temp>, and in the environment
// PYIDE_CLIPBOARD_MODE=save|restore and PYIDE_CLIPBOARD_FILE=<snapshot.json>.
// It keeps plain text, HTML, RTF and an image. A restore writes only when the clipboard changed since the
// save, so a suite that copies nothing leaves every format (files copied in Explorer, Office data) as it was.
const fs = require('fs');
const { app, clipboard, nativeImage } = require('electron');

app.disableHardwareAcceleration();

function read() {
  const image = clipboard.readImage();
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? '' : image.toPNG().toString('base64'),
    formats: clipboard.availableFormats(),
  };
}
const same = (a, b) => a.text === b.text && a.html === b.html && a.rtf === b.rtf && a.image === b.image;

function run() {
  const mode = process.env.PYIDE_CLIPBOARD_MODE;
  const file = process.env.PYIDE_CLIPBOARD_FILE;
  if (!file) return 2;
  if (mode === 'save') {
    fs.writeFileSync(file, JSON.stringify(read()));
    return 0;
  }
  if (mode !== 'restore') return 2;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (same(read(), saved)) return 0;
  const data = {};
  if (saved.text) data.text = saved.text;
  if (saved.html) data.html = saved.html;
  if (saved.rtf) data.rtf = saved.rtf;
  if (saved.image) data.image = nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64'));
  if (Object.keys(data).length) clipboard.write(data);
  else clipboard.clear();
  return 0;
}

app.whenReady().then(() => {
  let code = 1;
  try { code = run(); } catch (err) { console.error(err && err.stack); }
  app.exit(code);
}, () => app.exit(1));
