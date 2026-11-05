// Path checks for the cut:* channels that take a path from the renderer. Results are values ({error, code}), never
// throws: the renderer branches on the code ('badArgs', 'network', 'missing', 'notFile', 'extension', 'outside', 'io').
//
// Network paths are refused before anything touches them: opening \\host\share (or \\?\UNC\host\share, or a link
// whose target is one) makes Windows sign in to that host with the user's NTLM credentials. \\?\C:\... is a local
// long path and is read as C:\.... \\.\ device paths are refused. Every other check is made on the real path (realpath):
// an 8.3 name (VIDEO~1.MP4 for video.mp4x), a trailing dot, a junction or a symbolic link can make a name say one
// thing and open another.
const fs = require('fs');
const path = require('path');

const VIDEO = ['mp4', 'm4v', 'mov', 'mkv', 'webm', '3gp'];
// Only formats the editor can read: there is no Ogg or bare FLAC reader (FLAC, Opus and Vorbis work inside MP4 and MKV).
const AUDIO = ['mp3', 'wav', 'm4a', 'aac'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const MEDIA = new Set([...VIDEO, ...AUDIO, ...IMAGE]);
// What cut:read serves: the media an importer accepts, projects, captions and LUTs.
const READABLE = new Set([...MEDIA, 'ncut', 'srt', 'vtt', 'cube']);
// What the export sink writes: movies, audio, frames, captions and chapter lists.
const OUTPUT = new Set(['mp4', 'm4a', 'mov', 'webm', 'wav', 'png', 'jpg', 'jpeg', 'srt', 'vtt', 'txt']);
const FONT = new Set(['ttf', 'otf', 'ttc', 'otc']);
const MAX_LINK_HOPS = 32;

const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
const fail = (code, error) => ({ error, code });
// \\host\share, //host/share, \\?\UNC\..., \??\UNC\... and a bare UNC\host\share as readlink reports some link targets.
const isNetwork = (p) => /^[\\/]{2}/.test(p) || /^\\\?\?\\unc\\/i.test(p) || /^unc\\/i.test(p);
const isWindows = process.platform === 'win32';

// The local absolute form of a path, or why it is not one. Touches nothing.
function localPath(p) {
  if (typeof p !== 'string' || !p || p.length > 32767 || p.includes('\0')) return fail('badArgs', 'not a path');
  let s = p;
  if (/^[\\/]{2}[?.][\\/]/.test(s)) {
    const long = /^[\\/]{2}\?[\\/]([a-z]:[\\/].*)$/i.exec(s);
    if (!long) return fail('network', 'network and device paths are not opened');
    s = long[1];
  }
  if (isNetwork(s)) return fail('network', 'network paths are not opened');
  if (isWindows) {
    // C:foo is relative to that drive's current folder; a colon past the drive names an NTFS stream.
    if (!/^[a-z]:[\\/]/i.test(s)) return fail('badArgs', 'not an absolute path');
    if (s.indexOf(':', 2) >= 0) return fail('badArgs', 'not a file path');
  } else if (!path.isAbsolute(s)) return fail('badArgs', 'not an absolute path');
  return { path: path.resolve(s) };
}

// Follows every link on the way to p without opening the final file: a junction or symbolic link whose target is a
// network path is refused before realpath would open it. Returns null when no link leads to the network.
async function linkToNetwork(p) {
  let rest = p;
  for (let hops = 0; hops <= MAX_LINK_HOPS;) {
    const { root } = path.parse(rest);
    const parts = rest.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let cur = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      let st;
      try { st = await fs.promises.lstat(cur); } catch { return null; } // realpath reports what is missing
      if (!st.isSymbolicLink()) continue;
      let target;
      try { target = await fs.promises.readlink(cur); } catch { return null; }
      const long = /^(?:[\\/]{2}\?|\\\?\?)[\\/]([a-z]:[\\/].*)$/i.exec(target);
      if (long) target = long[1];
      else if (isNetwork(target)) return fail('network', 'a link here leads to a network path');
      rest = path.resolve(path.dirname(cur), target, ...parts.slice(i + 1));
      followed = true;
      hops++;
      break;
    }
    if (!followed) return null;
  }
  return fail('io', 'too many links');
}

// The real path of an existing local entry: {path, real, stat} or {error, code}.
async function realEntry(p) {
  const local = localPath(p);
  if (local.error) return local;
  const net = await linkToNetwork(local.path);
  if (net) return net;
  let real;
  try { real = await fs.promises.realpath(local.path); } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? fail('missing', 'no such file') : fail('io', err.message);
  }
  if (isNetwork(real)) return fail('network', 'network paths are not opened');
  let stat;
  try { stat = await fs.promises.stat(real); } catch (err) {
    return err.code === 'ENOENT' ? fail('missing', 'no such file') : fail('io', err.message);
  }
  return { path: local.path, real, stat };
}

// An existing regular file whose name, as given and as it really is, has one of `exts`.
async function realFile(p, exts) {
  const entry = await realEntry(p);
  if (entry.error) return entry;
  if (!entry.stat.isFile()) return fail('notFile', 'not a file');
  if (!exts.has(extOf(entry.path)) || !exts.has(extOf(entry.real))) return fail('extension', 'this kind of file is not opened here');
  return entry;
}

// Whether `inner` is `outer` or inside it (both resolved).
function isInside(outer, inner) {
  const rel = path.relative(outer, inner);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

// A path to write: local, with one of `exts`, in an existing folder that is not reached through a network link.
// The file itself may not exist yet.
async function writableFile(p, exts) {
  const local = localPath(p);
  if (local.error) return local;
  if (!exts.has(extOf(local.path))) return fail('extension', 'this kind of file is not written here');
  const dir = await realEntry(path.dirname(local.path));
  if (dir.error) return dir.code === 'missing' ? fail('missing', 'the folder does not exist') : dir;
  if (!dir.stat.isDirectory()) return fail('notFile', 'not a folder');
  const target = path.join(dir.real, path.basename(local.path));
  try {
    const st = await fs.promises.lstat(target);
    if (st.isDirectory() || st.isSymbolicLink()) return fail('notFile', 'not a file');
  } catch {}
  return { path: target };
}

module.exports = { MEDIA, READABLE, OUTPUT, FONT, extOf, fail, isNetwork, isInside, localPath, realEntry, realFile, writableFile };
