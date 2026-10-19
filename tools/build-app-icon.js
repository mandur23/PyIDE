// Renders the PyIDE logo (the welcome screen's "Py" tile) into build/icon.ico for the packaged app and installer.
// Usage: node_modules\electron\dist\electron.exe tools/build-app-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');

// One tile per size side by side, with the proportions of .welcome-logo in renderer/core/styles.css
// (48px tile, 11px radius, 18px text).
const WIDTH = SIZES.reduce((a, s) => a + s, 0);
const HEIGHT = Math.max(...SIZES);
const tile = (size) => `<div style="flex:none;width:${size}px;height:${size}px;border-radius:${size * 11 / 48}px;display:grid;
  place-items:center;font:800 ${size * 18 / 48}px 'Segoe UI',sans-serif;color:#000;
  background:linear-gradient(135deg,#21d789,#fcf84a)">Py</div>`;
const page = `<html><body style="margin:0;background:transparent;display:flex;align-items:flex-start">
  ${SIZES.map(tile).join('')}</body></html>`;

// An .ico whose entries are PNG images (supported since Windows Vista); a 256px entry stores its size as 0.
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size % 256, 0);
    e.writeUInt8(size % 256, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent(page)}`);
  const sheet = await win.webContents.capturePage();
  const scale = sheet.getSize().width / WIDTH;
  const pngs = [];
  let x = 0;
  for (const size of SIZES) {
    const crop = sheet.crop({ x: Math.round(x * scale), y: 0, width: Math.round(size * scale), height: Math.round(size * scale) });
    pngs.push({ size, png: crop.resize({ width: size, height: size, quality: 'best' }).toPNG() });
    x += size;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, ico(pngs));
  console.log(`wrote ${OUT}`);
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
