// HTTP Client backend: environments from http-client.env.json and http-client.private.env.json, {{variable}}
// substitution and request execution with Node's fetch, so requests have no CORS limits. Variables are resolved here
// rather than in the renderer, so private environment values reach the renderer only inside a request the user sees,
// and they are added to the log scrubber as soon as they are read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { addSecretValues } = require('../diagnostics/redact');

const ENV_FILE = 'http-client.env.json';
const PRIVATE_ENV_FILE = 'http-client.private.env.json';
const MAX_TEXT = 5 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
};
const isUnder = (p, dir) => {
  const r = path.relative(dir, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

// The nearest folder from the request file up to the project root that holds either environment file.
function envDir(file, root) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, ENV_FILE)) || fs.existsSync(path.join(dir, PRIVATE_ENV_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir || !root || !isUnder(up, root)) return null;
    dir = up;
  }
}

function loadEnvs(file, root) {
  const dir = envDir(file, root);
  if (!dir) return { dir: null, pub: {}, priv: {} };
  const pub = readJson(path.join(dir, ENV_FILE)) || {};
  const priv = readJson(path.join(dir, PRIVATE_ENV_FILE)) || {};
  const secrets = [];
  for (const vars of Object.values(priv)) if (vars && typeof vars === 'object') secrets.push(...Object.values(vars).map(String));
  addSecretValues(secrets);
  return { dir, pub, priv };
}

const envNames = ({ pub, priv }) => [...new Set([...Object.keys(pub), ...Object.keys(priv)])].filter((n) => n !== '$shared').sort();
const envVars = ({ pub, priv }, name) => ({ ...pub.$shared, ...priv.$shared, ...(name && pub[name]), ...(name && priv[name]) });

// Responses of named requests (`# @name login`), per project, for {{login.response.body.token}}.
const named = new Map();

// `body.$.items[0].id`, `body.items.0.id` or `headers.Location`.
function lookupResponse(resp, rest) {
  const m = /^(body|headers)(?:\.(.*))?$/.exec(rest);
  if (!m) return undefined;
  if (m[1] === 'headers') {
    if (!m[2]) return undefined;
    const want = m[2].toLowerCase();
    return resp.headers.find(([k]) => k.toLowerCase() === want)?.[1];
  }
  let value = resp.json !== undefined ? resp.json : resp.text;
  if (!m[2]) return typeof value === 'string' ? value : JSON.stringify(value);
  const steps = m[2].replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  for (const step of steps) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[step.startsWith('[') ? Number(step.slice(1, -1)) : step];
  }
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function dynamicVar(name) {
  if (name === '$uuid' || name === '$random.uuid') return crypto.randomUUID();
  if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
  if (name === '$isoTimestamp') return new Date().toISOString();
  if (name === '$randomInt') return String(crypto.randomInt(0, 1000));
  const m = /^\$random\.integer\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(name);
  if (m && Number(m[2]) > Number(m[1])) return String(crypto.randomInt(Number(m[1]), Number(m[2])));
  return undefined;
}

// In-file variables first (they may refer to environment variables), then the environment, dynamic variables and
// named responses. Unknown names stay as written and are reported.
function makeResolver({ fileVars, env, root }) {
  const local = new Map(fileVars);
  const unresolved = new Set();
  const resolveName = (name, depth) => {
    if (name.startsWith('$')) return dynamicVar(name);
    if (local.has(name)) return substitute(local.get(name), depth + 1);
    if (Object.prototype.hasOwnProperty.call(env, name)) return substitute(String(env[name]), depth + 1);
    const ref = /^([\w-]+)\.response\.(.+)$/.exec(name);
    const resp = ref && named.get(`${root}\n${ref[1]}`);
    return resp ? lookupResponse(resp, ref[2]) : undefined;
  };
  const substitute = (text, depth = 0) => (depth > 10 ? text : String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name) => {
    const v = resolveName(name, depth);
    if (v === undefined) { unresolved.add(name); return all; }
    return v;
  }));
  return { substitute, unresolved };
}

// A body is text, or a single `< ./file` line (sent as the file's bytes), or text with `< file` lines spliced in.
// `<@ file` also substitutes variables inside the file.
function buildBody(body, baseDir, substitute) {
  if (body == null || body === '') return { data: undefined };
  const include = (line) => {
    const m = /^<(@?)\s+(.+?)\s*$/.exec(line);
    if (!m) return null;
    const file = path.resolve(baseDir, substitute(m[2]));
    const buf = fs.readFileSync(file);
    return m[1] ? Buffer.from(substitute(buf.toString('utf8'))) : buf;
  };
  const lines = body.split(/\r?\n/);
  if (lines.length === 1 && /^<@?\s/.test(lines[0])) return { data: include(lines[0]) };
  const out = lines.map((l) => { const b = /^<@?\s/.test(l) ? include(l) : null; return b ? b.toString('utf8') : substitute(l); });
  return { data: out.join('\n') };
}

function kindOf(contentType) {
  const ct = (contentType || '').toLowerCase();
  if (/[/+]json\b/.test(ct)) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.startsWith('image/')) return 'image';
  if (/[/+]xml\b/.test(ct)) return 'xml';
  if (!ct || ct.startsWith('text/') || /javascript|x-www-form-urlencoded|yaml|csv/.test(ct)) return 'text';
  return 'binary';
}

// A readable reason for a failed request, translated by the renderer from `kind`.
function describeError(err, url, timeoutMs) {
  const cause = err?.cause || {};
  let target = '';
  try { const u = new URL(url); target = u.host; } catch {}
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { kind: 'timeout', target, seconds: Math.round(timeoutMs / 1000) };
  const code = cause.code || err?.code || '';
  if (code === 'ECONNREFUSED') return { kind: 'refused', target, code };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', target, code };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { kind: 'reset', target, code };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return { kind: 'timeout', target, code, seconds: Math.round(timeoutMs / 1000) };
  return { kind: 'other', target, code, detail: cause.message || err?.message || String(err) };
}

// The body up to `keep` bytes. A longer body is not downloaded further (it may be endless or gigabytes), and its
// size is the Content-Length when the server sent one; binary bodies (keep 0) are only counted, never held.
async function readBody(res, keep) {
  const chunks = [];
  let kept = 0;
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (!keep) continue;
      if (kept + chunk.length > keep) {
        chunks.push(chunk.subarray(0, keep - kept));
        const length = Number(res.headers.get('content-length'));
        return { buf: Buffer.concat(chunks), size: !res.headers.get('content-encoding') && length > size ? length : size, cut: true };
      }
      chunks.push(chunk);
      kept += chunk.length;
    }
  }
  return { buf: Buffer.concat(chunks), size, cut: false };
}

async function send({ file, root, env: envName, request, fileVars = [], timeoutMs = 60000 }) {
  const envs = loadEnvs(file, root);
  const { substitute, unresolved } = makeResolver({ fileVars, env: envVars(envs, envName), root });
  const method = (request.method || 'GET').toUpperCase();
  const url = substitute(request.url);
  const headers = request.headers.map(([k, v]) => [substitute(k), substitute(v)]);
  const shown = { method, url, headers, name: request.name || null };
  let body;
  try {
    body = ['GET', 'HEAD'].includes(method) ? { data: undefined } : buildBody(request.body, path.dirname(file), substitute);
  } catch (err) {
    return { ok: false, request: shown, error: { kind: 'file', detail: err.path || err.message } };
  }
  if (typeof body.data === 'string') shown.body = body.data;
  else if (body.data) shown.body = `<${body.data.length} bytes>`;
  try { if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('scheme'); } catch {
    return { ok: false, request: shown, unresolved: [...unresolved], error: { kind: 'url', detail: url } };
  }

  const started = performance.now();
  let res;
  let kind;
  let read;
  try {
    const h = new Headers();
    for (const [k, v] of headers) h.append(k, v);
    res = await fetch(url, { method, headers: h, body: body.data, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    kind = kindOf(res.headers.get('content-type'));
    read = await readBody(res, kind === 'image' ? MAX_IMAGE : kind === 'binary' ? 0 : MAX_TEXT);
  } catch (err) {
    return { ok: false, request: shown, unresolved: [...unresolved], timeMs: Math.round(performance.now() - started), error: describeError(err, url, timeoutMs) };
  }
  const timeMs = Math.round(performance.now() - started);
  const respHeaders = [...res.headers];
  const contentType = res.headers.get('content-type') || '';
  const { buf, size, cut } = read;
  // An image too large to keep is reported like binary content.
  if (kind === 'image' && cut) kind = 'binary';
  const response = { status: res.status, statusText: res.statusText, url: res.url, headers: respHeaders, contentType, kind, size, timeMs };
  if (kind === 'image') response.base64 = buf.toString('base64');
  else if (kind !== 'binary') {
    response.text = buf.toString('utf8');
    response.truncated = cut;
  }
  if (request.name) {
    let json;
    if (kind === 'json') try { json = JSON.parse(response.text); } catch {}
    named.set(`${root}\n${request.name}`, { headers: respHeaders, text: response.text ?? '', json });
  }
  return { ok: true, request: shown, unresolved: [...unresolved], response };
}

exports.register = ({ ipcMain }) => {
  ipcMain.handle('http-client:envs', (_e, file, root) => {
    const envs = loadEnvs(file, root);
    return { dir: envs.dir, names: envNames(envs) };
  });
  ipcMain.handle('http-client:send', (_e, args) => send(args));
};
