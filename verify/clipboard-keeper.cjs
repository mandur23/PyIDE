// Saves and restores the system clipboard around a test run (verify/lib.mjs). Test windows run on a hidden desktop
// but share the user's clipboard, and suites copy, cut and Copy Path for real. Run as an Electron main script, with no
// window: electron.exe verify/clipboard-keeper.cjs --user-data-dir=<temp>, and in the environment
// PYIDE_CLIPBOARD_MODE=save|restore and PYIDE_CLIPBOARD_FILE=<snapshot.json>.
// It keeps every type clipboard.read() reports. A restore writes only when the clipboard changed since the save, so a
// suite that copies nothing leaves every format (files copied in Explorer, Office data) as it was.
const fs = require('fs');
const { app, clipboard, ClipboardItem } = require('electron');

app.disableHardwareAcceleration();

// -> [{type: base64}], one object per clipboard item. A bookmark comes as an object, not a Blob, and is not kept.
async function read() {
  const items = [];
  for (const item of await clipboard.read()) {
    const data = {};
    for (const type of item.types) {
      const value = await item.getType(type);
      if (value instanceof Blob) data[type] = Buffer.from(await value.arrayBuffer()).toString('base64');
    }
    items.push(data);
  }
  return items;
}
const toItem = (data) => new ClipboardItem(Object.fromEntries(Object.entries(data)
  .map(([type, base64]) => [type, new Blob([Buffer.from(base64, 'base64')], { type })])));

async function run() {
  const mode = process.env.PYIDE_CLIPBOARD_MODE;
  const file = process.env.PYIDE_CLIPBOARD_FILE;
  if (!file) return 2;
  if (mode === 'save') {
    fs.writeFileSync(file, JSON.stringify(await read()));
    return 0;
  }
  if (mode !== 'restore') return 2;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (JSON.stringify(await read()) === JSON.stringify(saved)) return 0;
  if (saved.length) await clipboard.write(saved.map(toItem));
  else clipboard.clear();
  return 0;
}

app.whenReady().then(run).then((code) => app.exit(code), (err) => {
  console.error(err && err.stack);
  app.exit(1);
});
