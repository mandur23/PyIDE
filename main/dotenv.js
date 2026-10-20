// .env files with dotenv semantics, for Run, Debug, the test runner, the Python Console and new terminals.
// Values are treated as secrets: they are added to the log scrubber, and the log only ever names files and lines.
const fs = require('fs');
const path = require('path');
const { addSecretValues } = require('./diagnostics/redact');
const log = require('./diagnostics').logger('#dotenv');
const trust = require('./trust');

const ESCAPES = { n: '\n', r: '\r', t: '\t', v: '\v', f: '\f', b: '\b', a: '\x07', '\\': '\\', '"': '"', "'": "'", $: '$' };
const ENTRY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const REF = /\$\{([^}\n"]*)\}/y; // ${…} at a position inside double quotes
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Windows environment names are case-insensitive; a copied process.env is not.
function lookupIn(base, name) {
  if (hasOwn(base, name)) return base[name];
  if (process.platform !== 'win32') return undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(base).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : base[key];
}

// Parses .env text. lookup(name) resolves ${VAR} for names not set earlier in this text.
// Returns {env, errors}, where errors lists the 1-based lines that were skipped.
//   KEY=value              unquoted: trimmed, ` #` starts a comment, ${VAR} and ${VAR:-default} expand
//   export KEY=value       `export ` is ignored
//   KEY="a\nb ${VAR}"      double quotes: escapes and expansion, may span lines
//   KEY='a\nb ${VAR}'      single quotes: literal, may span lines
//   # comment
function parse(text, lookup = () => undefined) {
  const env = {};
  const errors = [];
  const resolve = (ref) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(ref);
    if (!m) return '';
    const v = hasOwn(env, m[1]) ? env[m[1]] : lookup(m[1]);
    return v === undefined || (v === '' && m[2] !== undefined) ? m[2] ?? '' : v;
  };
  const expand = (s) => s.replace(/\$\{([^}]*)\}/g, (_m, ref) => resolve(ref));

  const s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  const lineEnd = (from) => { const e = s.indexOf('\n', from); return e < 0 ? s.length : e; };
  while (i < s.length) {
    const startLine = line;
    const end = lineEnd(i);
    const head = ENTRY.exec(s.slice(i, end));
    if (!head) {
      if (!BLANK_OR_COMMENT.test(s.slice(i, end))) errors.push(startLine);
      i = end + 1;
      line++;
      continue;
    }
    const key = head[1];
    let j = i + head[0].length;
    const quote = s[j];
    if (quote === '"' || quote === "'") {
      let value = '';
      let closed = false;
      let nl = 0;
      for (j++; j < s.length; j++) {
        const c = s[j];
        if (c === quote) { closed = true; j++; break; }
        if (c === '\n') nl++;
        if (quote === '"' && c === '\\' && j + 1 < s.length) {
          const n = s[++j];
          if (n === '\n') nl++;
          value += hasOwn(ESCAPES, n) ? ESCAPES[n] : `\\${n}`;
        } else if (quote === '"' && c === '$' && (REF.lastIndex = j, REF.test(s))) {
          value += resolve(s.slice(j + 2, REF.lastIndex - 1));
          j = REF.lastIndex - 1;
        } else value += c;
      }
      const rest = closed ? s.slice(j, lineEnd(j)) : null;
      if (!closed || !BLANK_OR_COMMENT.test(rest)) {
        // An unterminated quote would swallow the rest of the file; skip only its first line.
        errors.push(startLine);
        i = end + 1;
        line++;
        continue;
      }
      env[key] = value;
      i = lineEnd(j) + 1;
      line += nl + 1;
    } else {
      let raw = s.slice(j, end);
      const hash = raw.search(/(?:^|[ \t])#/);
      if (hash >= 0) raw = raw.slice(0, hash);
      env[key] = expand(raw.trim());
      i = end + 1;
      line++;
    }
  }
  return { env, errors };
}

// Loads files in order; later files override earlier ones and can refer to their keys. A missing file is skipped.
function loadFiles(files, base = process.env) {
  const env = {};
  const lookup = (name) => (hasOwn(env, name) ? env[name] : lookupIn(base, name));
  for (const file of files) {
    // An untrusted project's .env could set PATH, PYTHONSTARTUP and the like for everything started from it.
    if (!trust.isTrusted(path.dirname(file))) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`${file}: ${err.code || err.message}`);
      continue;
    }
    const r = parse(text, lookup);
    for (const n of r.errors) log.warn(`${file}:${n}: not a KEY=value entry, skipped`);
    Object.assign(env, r.env);
  }
  addSecretValues(Object.values(env));
  return env;
}

// The environment a launcher passes on: the env files' variables, overridden by the explicit ones.
// envFiles: absolute paths; undefined means the default, the project root's .env (if it exists).
function withEnvFiles(env = {}, envFiles, root) {
  const files = envFiles ?? (root ? [path.join(root, '.env')] : []);
  return files.length ? { ...loadFiles(files), ...env } : env;
}

module.exports = { parse, loadFiles, withEnvFiles };
