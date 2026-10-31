// The files of one folder (a server's client pack, its resource pack) over http on loopback, for the Ports plugin's
// tunnel to carry. It runs in the app, so sharing a pack needs no Python, which Craft's users may not have. What goes
// through the tunnel is public: only the folder's own files by name, GET and HEAD, and no folder listing.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pipeline } = require('stream');

const servers = new Map(); // folder (lower case) -> Promise<port>

function answer(folder, req, res) {
  const refuse = (code) => { res.writeHead(code); res.end(); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405);
  let name;
  try { name = decodeURIComponent(new URL(req.url, 'http://local').pathname.slice(1)); } catch { return refuse(400); }
  if (!name || path.basename(name) !== name || /[\\:\0]/.test(name)) return refuse(404);
  const file = path.join(folder, name);
  // lstat: a link in the folder is not one of its files, whatever it points at. A stranger picks the name, and one too
  // long or with characters Windows refuses throws here, in the process that runs the app.
  let stat = null;
  try { stat = fs.lstatSync(file, { throwIfNoEntry: false }); } catch {}
  if (!stat?.isFile()) return refuse(404);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  // pipeline closes the file when a client hangs up, which .pipe does not.
  pipeline(fs.createReadStream(file), res, () => {});
}

// -> the port serving `folder`, the same one while the app runs.
function serve(folder) {
  const key = path.resolve(folder).toLowerCase();
  if (!servers.has(key)) {
    servers.set(key, new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => answer(folder, req, res));
      server.once('error', (err) => { servers.delete(key); reject(err); });
      server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); });
    }));
  }
  return servers.get(key);
}

module.exports = { serve };
