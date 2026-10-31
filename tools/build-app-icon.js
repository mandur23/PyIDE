// Builds build/icon.ico from renderer/core/logo.svg, each size rendered from the SVG rather than scaled down:
// Usage: node_modules\electron\dist\electron.exe tools/build-app-icon.js [folder for the PNGs]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let at = head.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head[o] = head[o + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(at, o + 12);
    at += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'renderer/core/logo.svg'), 'utf8');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<!doctype html><canvas></canvas>');
  const render = (size) => win.webContents.executeJavaScript(`new Promise((done, fail) => {
    const img = new Image(); img.onerror = fail;
    img.onload = () => {
      const c = document.querySelector('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size});
      done(c.toDataURL('image/png').split(',')[1]);
    };
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: Buffer.from(await render(size), 'base64') });
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), ico(pngs));
  const out = process.argv[2];
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const { size, data } of pngs) fs.writeFileSync(path.join(out, `icon-${size}.png`), data);
  }
  console.log(`build/icon.ico: ${SIZES.join(', ')}`);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
