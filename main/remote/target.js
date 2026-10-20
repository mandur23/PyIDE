// Remote interpreter targets, like PyCharm's "Add Interpreter > On WSL / On SSH / On Docker".
// A target is {id, kind: 'wsl'|'ssh'|'docker'|'compose', python, ...kind fields, root}. Everything runs as a POSIX
// shell script through the kind's local client (wsl.exe, ssh.exe, docker), and a PathMap translates between the
// Windows project folder and where the target sees it. This file is pure (no processes); see session.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['wsl', 'ssh', 'docker', 'compose'];

// POSIX single-quoting: safe for sh, bash, zsh, dash and busybox.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const isWinAbs = (p) => typeof p === 'string' && (/^[A-Za-z]:([\\/]|$)/.test(p) || /^\\\\[^\\]/.test(p));
const trimSep = (p) => (/^[A-Za-z]:\\?$/.test(p) ? `${p.slice(0, 2)}\\` : p.replace(/[\\/]+$/, ''));
const normWin = (p) => trimSep(path.win32.normalize(p));
const under = (p, dir) => {
  const a = p.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b.endsWith('\\') ? b : `${b}\\`);
};
const underPosix = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
const joinPosix = (dir, rel) => (rel ? `${dir.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}` : dir);

// Translates paths between this machine and a target. entries: [{local, remote}] folders shared with (or synced to)
// the target, longest match first. WSL additionally sees every drive under its automount root (/mnt/c/...), and
// any other Linux path is readable from Windows as \\wsl.localhost\<distro>\....
class PathMap {
  constructor(entries = [], { automount = null, distro = null } = {}) {
    this.entries = entries
      .filter((e) => e.local && e.remote)
      .map((e) => ({ local: normWin(e.local), remote: e.remote.replace(/(.)\/+$/, '$1') }));
    this.automount = automount;
    this.distro = distro;
  }

  toRemote(p) {
    if (!isWinAbs(p)) return null;
    const n = normWin(p);
    const hit = [...this.entries].sort((a, b) => b.local.length - a.local.length).find((e) => under(n, e.local));
    if (hit) return joinPosix(hit.remote, n.slice(hit.local.length).replace(/\\/g, '/'));
    if (this.automount && /^[A-Za-z]:/.test(n)) return joinPosix(`${this.automount}${n[0].toLowerCase()}`, n.slice(2).replace(/\\/g, '/'));
    return null;
  }

  toLocal(p) {
    if (typeof p !== 'string' || !p.startsWith('/')) return null;
    const hit = [...this.entries].sort((a, b) => b.remote.length - a.remote.length).find((e) => underPosix(p, e.remote));
    if (hit) {
      const rest = p.slice(hit.remote.length).replace(/^\/+/, '');
      return rest ? path.win32.join(hit.local, rest) : hit.local;
    }
    if (this.automount && p.startsWith(this.automount)) {
      const m = /^([a-z])(\/.*)?$/i.exec(p.slice(this.automount.length));
      if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
    }
    if (this.distro) return `\\\\wsl.localhost\\${this.distro}${p.replace(/\//g, '\\')}`;
    return null;
  }

  // debugpy's attach pathMappings for the folders the user's breakpoints live in.
  debugMappings(root) {
    const remote = root && this.toRemote(root);
    return remote ? [{ localRoot: normWin(root), remoteRoot: remote }] : [];
  }

  serialize() {
    return { entries: this.entries, automount: this.automount, distro: this.distro };
  }
}

// Maps one command-line argument: a Windows path becomes the target's path. A Windows path the target cannot see
// is kept, so the program reports it as missing instead of silently running something else.
const mapArg = (map, a) => (isWinAbs(a) ? map.toRemote(a) ?? a : a);

// Environment for the target. PYTHONPATH (';'-separated here) becomes ':'-separated target paths; entries the target
// cannot see are dropped. Other values that are Windows paths are mapped when possible.
function mapEnv(map, env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null) continue;
    if (k === 'PYTHONPATH') {
      const parts = String(v).split(';').filter(Boolean).map((p) => (isWinAbs(p) ? map.toRemote(p) : p.includes('\\') ? null : p)).filter(Boolean);
      if (parts.length) out[k] = [...new Set(parts)].join(':');
    } else out[k] = isWinAbs(v) ? map.toRemote(v) ?? v : String(v);
  }
  return out;
}

// A stable short id for a target, and the executable URI that identifies its interpreter in ide.interps.
const targetId = () => crypto.randomBytes(5).toString('hex');
function executableUri(t) {
  const where = t.kind === 'wsl' ? t.distro
    : t.kind === 'ssh' ? `${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`
      : t.kind === 'docker' ? t.image : `${t.service}@${path.basename(t.composeFile || '')}`;
  return `${t.kind}://${where}${t.python.startsWith('/') ? '' : '/'}${t.python}#${t.id}`;
}
const idFromExecutable = (exe) => (/^(wsl|ssh|docker|compose):\/\/.*#([\w-]+)$/.exec(exe || '') || [])[2] || null;
const isRemoteExecutable = (exe) => !!idFromExecutable(exe);

// Human name of a target, as PyCharm labels remote interpreters.
function describe(t) {
  if (t.kind === 'wsl') return `WSL ${t.distro}`;
  if (t.kind === 'ssh') return `SSH ${t.user ? `${t.user}@` : ''}${t.host}${t.port && Number(t.port) !== 22 ? `:${t.port}` : ''}`;
  if (t.kind === 'docker') return `Docker ${t.image}`;
  return `Compose ${t.service}`;
}

// Finds a program on PATH the way Windows does for .exe files (PATH order, so a stand-in earlier on PATH wins).
function findTool(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(';').filter(Boolean);
  const names = /\.\w+$/.test(name) ? [name] : [`${name}.exe`, name];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d.replace(/^"|"$/g, ''), n);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// Host entries of ~/.ssh/config (PYIDE_SSH_CONFIG overrides the file): concrete aliases only, no wildcard patterns.
function sshConfigHosts(file = process.env.PYIDE_SSH_CONFIG || path.join(os.homedir(), '.ssh', 'config')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value.split(/\s+/).filter((a) => a && !/[*?!]/.test(a)).map((alias) => ({ alias }));
      hosts.push(...current);
    } else if (key === 'match') current = [];
    else {
      const field = { hostname: 'hostName', user: 'user', port: 'port', identityfile: 'identityFile' }[key];
      if (field) for (const h of current) h[field] ??= field === 'port' ? Number(value) : value;
    }
  }
  return hosts;
}

// `wsl.exe -l -v` writes UTF-16LE, with or without a BOM (or UTF-8 with WSL_UTF8=1); rows are "[*] NAME STATE VERSION".
// The header and STATE are in the Windows display language and STATE may be several words ("실행 중"), while a
// distribution name has no spaces: NAME is the first token after the optional '*', VERSION the last, STATE the rest.
function parseWslList(buf) {
  const utf16 = (buf.length > 1 && buf[1] === 0) || (buf[0] === 0xff && buf[1] === 0xfe);
  const text = (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
  const rows = text.replace(/\0/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const row of rows.slice(1)) {
    const m = /^(\*\s*)?(\S+)\s+(.+?)\s+(\d+)$/.exec(row);
    if (m) out.push({ name: m[2], state: m[3], version: Number(m[4]), default: !!m[1] });
  }
  return out;
}

module.exports = {
  KINDS, PathMap, q, isWinAbs, normWin, joinPosix, mapArg, mapEnv, targetId, executableUri, idFromExecutable,
  isRemoteExecutable, describe, findTool, sshConfigHosts, parseWslList,
};
