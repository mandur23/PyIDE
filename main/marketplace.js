// The online plugin Marketplace: an index.json (format 1) that lists plugin .zip files with their sha256 and size.
// It is read from an https URL, from http on this computer (127.0.0.1, localhost), or from a local folder or file
// (a path or file: URL). Everything in it is checked here, at the boundary; the rest of the IDE trusts parseIndex's
// result. scripts/marketplace.mjs writes the index and the zips.
//
// {
//   "format": 1,
//   "plugins": [{
//     "id": "word-count", "name": "...", "version": "0.9.1", "vendor": "...", "description": "...",
//     "i18n": {"ko": {"name": "...", "description": "..."}},   optional
//     "minIdeVersion": "0.2.5",                                optional
//     "url": "word-count-0.9.1.zip",                           relative to the index, or absolute
//     "sha256": "<64 hex>", "size": 1234,
//     "homepage": "https://..."                                optional
//   }]
// }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

const FORMAT = 1;
const DEFAULT_URL = 'https://raw.githubusercontent.com/mandur23/PyIDE/master/marketplace/index.json';
const MAX_INDEX = 1024 * 1024;
const MAX_PLUGIN = 20 * 1024 * 1024;
const MAX_PLUGINS = 500;
const TIMEOUT = 15000;
// Stricter than plugin-manager's ID: the id names a folder, and Windows drops trailing dots and reserves device names.
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?$/;

// Semantic version order, prerelease below its release (0.2.5-beta.1 < 0.2.5).
function compareVersions(a, b) {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) return String(a).localeCompare(String(b), 'en', { numeric: true });
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined || xb[i] === undefined) return xa[i] === undefined ? -1 : 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const loopback = (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
// Where an index may live, and where its downloads may come from: https, http on this computer, or (for a local
// index only) a local file.
function allowedUrl(u, localIndex) {
  if (u.username || u.password) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u)) || (localIndex && u.protocol === 'file:');
}

// The index location from the setting's text: a URL, or a folder (its index.json) or .json file.
function resolveSource(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    let u;
    try { u = new URL(text); } catch { throw new Error(`Not a valid URL: ${text}`); }
    if (!allowedUrl(u, false)) throw new Error('The Marketplace URL must use https (http only on this computer)');
    if (u.pathname.endsWith('/')) u.pathname += 'index.json';
    return u;
  }
  const p = /^file:/i.test(text) ? fileURLToPath(text) : text;
  if (!path.isAbsolute(p)) throw new Error(`Not a URL or an absolute path: ${text}`);
  const file = /\.json$/i.test(p) ? p : path.join(p, 'index.json');
  return pathToFileURL(path.resolve(file));
}

// The index an installed copy uses until the user sets one. Source runs have none, so the verify suites and a
// development run never reach GitHub unless asked. PYIDE_MARKETPLACE_URL replaces it ('off': none).
function defaultSource({ packaged }) {
  const env = process.env.PYIDE_MARKETPLACE_URL;
  if (env != null) return /^off$/i.test(env.trim()) ? '' : env;
  return packaged ? DEFAULT_URL : '';
}

const urlOf = (s, base) => { try { return new URL(s, base); } catch { return null; } };
function fail(where, what) { throw new Error(`Marketplace index is not valid: ${where} ${what}`); }
function text(v, where, max, { optional = false, oneLine = true } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.trim()) fail(where, 'must be a non-empty string');
  if (v.length > max) fail(where, `is longer than ${max} characters`);
  if ((oneLine ? /[\0-\x1f\x7f]/ : /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(v)) fail(where, 'contains control characters');
  return v.trim();
}

// Raw index JSON text -> [{id, name, version, vendor, description, i18n, minIdeVersion, url, sha256, size, homepage}],
// with url absolute. Throws one readable message naming the first problem.
function parseIndex(raw, indexUrl) {
  if (Buffer.byteLength(raw) > MAX_INDEX) fail('the file', `is larger than ${MAX_INDEX / 1024} KB`);
  let data;
  try { data = JSON.parse(String(raw).replace(/^﻿/, '')); } catch (e) { fail('the file', `is not JSON (${e.message})`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('the file', 'must be a JSON object');
  if (data.format !== FORMAT) {
    if (Number.isInteger(data.format) && data.format > FORMAT) throw new Error(`The Marketplace index has format ${data.format}, which needs a newer Nano Studio (this one reads format ${FORMAT})`);
    fail('"format"', `must be ${FORMAT}`);
  }
  if (!Array.isArray(data.plugins)) fail('"plugins"', 'must be a list');
  if (data.plugins.length > MAX_PLUGINS) fail('"plugins"', `has more than ${MAX_PLUGINS} entries`);
  const base = new URL(indexUrl);
  const localIndex = base.protocol === 'file:';
  const ids = new Set();
  return data.plugins.map((e, i) => {
    const at = (k) => `plugins[${i}]${k ? `.${k}` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail(at(), 'must be an object');
    if (typeof e.id !== 'string' || e.id.length < 2 || e.id.length > 64 || !ID.test(e.id) || DEVICE.test(e.id)) {
      fail(at('id'), 'must be 2-64 lowercase letters or digits, joined by ".", "_" or "-"');
    }
    if (ids.has(e.id)) fail(at('id'), `"${e.id}" is listed twice`);
    ids.add(e.id);
    const version = (k) => {
      if (typeof e[k] !== 'string' || !VERSION.test(e[k])) fail(at(k), 'must be a version such as 1.2.0');
      return e[k];
    };
    let i18n = {};
    if (e.i18n !== undefined) {
      if (!e.i18n || typeof e.i18n !== 'object' || Array.isArray(e.i18n)) fail(at('i18n'), 'must be an object');
      for (const [lang, l] of Object.entries(e.i18n)) {
        if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) fail(at('i18n'), `has an unknown language "${lang.slice(0, 20)}"`);
        if (!l || typeof l !== 'object' || Array.isArray(l)) fail(at(`i18n.${lang}`), 'must be an object');
        i18n[lang] = {
          name: text(l.name, at(`i18n.${lang}.name`), 100, { optional: true }),
          description: text(l.description, at(`i18n.${lang}.description`), 2000, { optional: true, oneLine: false }),
        };
      }
    }
    const url = urlOf(text(e.url, at('url'), 2048), base) || fail(at('url'), 'is not a valid URL');
    if (!allowedUrl(url, localIndex)) fail(at('url'), localIndex ? 'must be https or a local file' : 'must be https');
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) fail(at('sha256'), 'must be 64 hexadecimal digits');
    if (!Number.isInteger(e.size) || e.size < 1 || e.size > MAX_PLUGIN) fail(at('size'), `must be a whole number of bytes from 1 to ${MAX_PLUGIN}`);
    const homepage = e.homepage === undefined ? undefined : urlOf(text(e.homepage, at('homepage'), 2048)) || fail(at('homepage'), 'is not a valid URL');
    if (homepage && homepage.protocol !== 'https:') fail(at('homepage'), 'must be https');
    return {
      id: e.id,
      name: text(e.name, at('name'), 100),
      version: version('version'),
      vendor: text(e.vendor, at('vendor'), 100),
      description: text(e.description, at('description'), 2000, { oneLine: false }),
      i18n,
      minIdeVersion: e.minIdeVersion === undefined ? undefined : version('minIdeVersion'),
      url: url.href,
      sha256: e.sha256.toLowerCase(),
      size: e.size,
      homepage: homepage?.href,
    };
  });
}

// The bytes at a URL (https, loopback http, or file:), at most `max`.
async function readUrl(href, max) {
  const u = new URL(href);
  if (u.protocol === 'file:') {
    const file = fileURLToPath(u);
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error(`${file} does not exist`);
    if (st.size > max) throw new Error(`${path.basename(file)} is larger than ${max} bytes`);
    return fs.promises.readFile(file);
  }
  let res;
  try {
    res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT), headers: { 'Cache-Control': 'no-cache' } });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'no answer' : (err.cause?.code || err.cause?.message || err.message);
    throw new Error(`Cannot reach ${u.host} (${why})`);
  }
  if (!allowedUrl(new URL(res.url || href), false)) throw new Error(`${u.host} redirected to a URL that is not https`);
  if (!res.ok) throw new Error(`${u.host} answered ${res.status} ${res.statusText}`.trim());
  if (Number(res.headers.get('content-length')) > max) throw new Error(`The download is larger than ${max} bytes`);
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > max) throw new Error(`The download is larger than ${max} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function fetchIndex(source) {
  return parseIndex((await readUrl(source.href, MAX_INDEX)).toString('utf8'), source.href);
}

// A listed plugin's .zip, checked against the index's size and sha256 before anything is unpacked.
async function download(entry) {
  const body = await readUrl(entry.url, entry.size);
  if (body.length !== entry.size) throw new Error(`The download has ${body.length} bytes, the index says ${entry.size}`);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (sha !== entry.sha256) throw new Error(`The download of ${entry.id} does not match the index's sha256 (got ${sha.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…)`);
  return body;
}

module.exports = { FORMAT, compareVersions, resolveSource, defaultSource, parseIndex, fetchIndex, download };
