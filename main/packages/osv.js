// Known vulnerabilities of PyPI packages from the OSV database (https://osv.dev): which version a requirement line
// stands for, the OSV advisory reduced to what the IDE shows, the first version that fixes every advisory, and the
// requirement text upgraded to it. Pure functions; main/features/vulnerabilities.js does the network and the cache.
const deps = require('./deps');

const { normName, parseVersion, compareVersions, specifierMatches } = deps;
// Advisory data may come from a damaged cache file: anything that is not a list counts as an empty one.
const list = (x) => (Array.isArray(x) ? x : []);
const keyOf = (name, version) => `${normName(name)}@${String(version).trim().toLowerCase()}`;

// '0' (OSV's "from the start") sorts first; versions that do not parse keep their place after the ones that do.
function cmpVersion(a, b) {
  if (a === b) return 0;
  if (a === '0') return -1;
  if (b === '0') return 1;
  const va = parseVersion(a), vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb);
  return va ? -1 : vb ? 1 : 0;
}

// The version a requirement line stands for: an exact pin (== without a wildcard, ===), else the lock file's
// resolved version, else the installed version when it satisfies the requirement. null when none is known.
function requirementVersion(req, locked) {
  if (req.url) return null;
  const clauses = String(req.spec || '').split(/\s*\|\|\s*/)[0].split(',').map((s) => s.trim()).filter(Boolean);
  const pin = clauses.map((c) => /^(===?)\s*([^\s*]+)$/.exec(c)).find(Boolean);
  if (pin && clauses.length === 1) return { version: pin[2], from: 'pin' };
  const lock = locked?.get(normName(req.name));
  if (lock) return { version: lock, from: 'lock' };
  if (pin) return { version: pin[2], from: 'pin' };
  if (req.status === 'ok' && req.installed) return { version: req.installed, from: 'installed' };
  return null;
}

// uv.lock and poetry.lock: [[package]] tables with name and version. -> Map normName -> version
function parseLock(text) {
  const out = new Map();
  let inPackage = false;
  let name = null;
  let version = null;
  const flush = () => { if (inPackage && name && version && !out.has(normName(name))) out.set(normName(name), version); name = version = null; };
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (header) { flush(); inPackage = /^\[\[/.test(line.trim()) && header[1] === 'package'; continue; }
    if (!inPackage) continue;
    const kv = /^\s*(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) { if (kv[1] === 'name') name ??= kv[2]; else version ??= kv[2]; }
  }
  flush();
  return out;
}

// The affected ranges of one OSV advisory for one package: [{events: [{type, v}]}] plus explicit versions.
function affectedOf(vuln, name) {
  const n = normName(name);
  return list(vuln?.affected).filter((a) => String(a?.package?.ecosystem || '').toLowerCase() === 'pypi' && normName(String(a.package.name || '')) === n);
}

// OSV's range rule: walk the events in version order up to `version`; introduced turns it on, fixed (>=) and
// last_affected (>) turn it off. An explicit `versions` entry is affected too.
function isAffected(vuln, name, version) {
  for (const a of affectedOf(vuln, name)) {
    if (list(a.versions).some((v) => cmpVersion(v, version) === 0)) return true;
    for (const range of list(a.ranges)) {
      if (!/^(ECOSYSTEM|SEMVER)$/.test(range?.type)) continue;
      const events = list(range.events).map((e) => {
        const type = Object.keys(e || {})[0];
        return { type, v: String(e[type]) };
      }).filter((e) => e.type).sort((x, y) => cmpVersion(x.v, y.v));
      let on = false;
      for (const e of events) {
        const c = cmpVersion(version, e.v);
        if (e.type === 'introduced' && (e.v === '0' || c >= 0)) on = true;
        else if (e.type === 'fixed' && c >= 0) on = false;
        else if (e.type === 'last_affected' && c > 0) on = false;
      }
      if (on) return true;
    }
  }
  return false;
}

const fixedVersions = (vuln, name) => [...new Set(affectedOf(vuln, name)
  .flatMap((a) => list(a.ranges).flatMap((r) => list(r?.events).filter((e) => e?.fixed).map((e) => String(e.fixed)))))]
  .sort(cmpVersion);

// The first version above `version` that none of the advisories affects, from the versions they name as fixed.
// null when no advisory names a fix.
function firstFixed(vulns, name, version) {
  const candidates = [...new Set(vulns.flatMap((v) => fixedVersions(v, name)))].filter((f) => cmpVersion(f, version) > 0).sort(cmpVersion);
  return candidates.find((c) => !vulns.some((v) => isAffected(v, name, c))) || candidates[candidates.length - 1] || null;
}

const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// An OSV advisory as the IDE shows it. Severity: the database's own label (GitHub's "HIGH", "MODERATE"...), else
// the first CVSS vector.
function summarize(vuln, name) {
  const id = String(vuln.id || '');
  const label = vuln.database_specific?.severity || affectedOf(vuln, name).map((a) => a.ecosystem_specific?.severity || a.database_specific?.severity).find(Boolean);
  const cvss = list(vuln.severity).find((s) => s?.score);
  const refs = list(vuln.references);
  const link = httpUrl(refs.find((r) => r?.type === 'ADVISORY')?.url) || `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
  const summary = String(vuln.summary || String(vuln.details || '').split(/\r?\n/).find((l) => l.trim()) || '').trim().slice(0, 300);
  return {
    id,
    aliases: list(vuln.aliases).filter((a) => typeof a === 'string'),
    summary,
    severity: typeof label === 'string' ? label : cvss ? `${cvss.type} ${cvss.score}` : null,
    fixed: fixedVersions(vuln, name),
    link,
  };
}

// The fixed version comes from the advisory database and is written into the user's file: PEP 440 characters only.
const SAFE_VERSION = /^[A-Za-z0-9](?:[A-Za-z0-9.+!_-]*[A-Za-z0-9])?$/;
const CLAUSE = /^(\s*)(~=|===|==|!=|<=|>=|<|>)(\s*)([A-Za-z0-9][A-Za-z0-9.*+!_-]*)(\s*)$/;

// A requirement as written with its version specifier raised to `fixed`. `text` runs from the name to the end of the
// requirement's last line: in requirements.txt that includes a comment, pip options and `\` continuation lines.
// Every clause the fixed version satisfies stays as written (~=, ==X.*, <, <=, !=); an exact pin (==, ===) is pinned
// to the fixed version; the first lower bound (>=, >) becomes >=fixed and the others go; without a pin or a lower
// bound, >=fixed is added after the last clause. Name, extras, marker, comment, options, continuations and spacing are
// kept: 'django~=3.2.0  # LTS' -> 'django~=3.2.0,>=3.2.25  # LTS'.
// null when there is nothing safe to offer: a clause the user wrote excludes the fixed version ('~=3.1.0' with a fix
// in 3.2.25; pinning past it would silently break the declared compatibility, and the advisory still says where the
// fix is), the requirement has --hash options (the hashes would no longer match), it is a URL requirement, its
// specifier is not understood, or nothing would change.
function upgradeRequirement(text, fixed) {
  text = String(text ?? '');
  fixed = String(fixed ?? '').trim();
  if (!SAFE_VERSION.test(fixed) || !parseVersion(fixed)) return null;
  // `text` with every backslash-newline continuation blanked: the same length, so positions carry over.
  const flat = text.replace(/\\[ \t]*\r?\n/g, (m) => ' '.repeat(m.length));
  // pip's comments start at a # at the line start or after whitespace; options start with - after whitespace.
  const comment = /(^|\s)#/.exec(flat);
  const body = comment ? flat.slice(0, comment.index + comment[1].length) : flat;
  if (/\s--hash\b/i.test(body)) return null;
  const option = /\s--?[A-Za-z]/.exec(body);
  const contentEnd = option ? option.index : body.length;
  const name = /^\s*[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\s*\[[^\]]*\])?/.exec(flat.slice(0, contentEnd));
  if (!name) return null;
  const rest = flat.slice(name[0].length, contentEnd);
  if (/^\s*@/.test(rest)) return null;
  const semi = rest.indexOf(';');
  let start = name[0].length;
  let end = start + (semi < 0 ? rest.length : semi);
  const paren = /^(\s*\()([^()]*)\)\s*$/.exec(flat.slice(start, end));
  if (paren) { start += paren[1].length; end = start + paren[2].length; }

  const inner = flat.slice(start, end);
  const clauses = [];
  if (inner.trim()) {
    let at = start;
    for (const part of inner.split(',')) {
      const m = CLAUSE.exec(part);
      if (!m) return null;
      const opAt = at + m[1].length;
      const verAt = opAt + m[2].length + m[3].length;
      clauses.push({ op: m[2], version: m[4], lead: text.slice(at, opAt), sp: text.slice(opAt + m[2].length, verAt), trail: text.slice(verAt + m[4].length, at + part.length) });
      at += part.length + 1;
    }
  }
  const satisfied = (c) => specifierMatches(`${c.op}${c.version}`, fixed);
  const isPin = (c) => c.op === '===' || (c.op === '==' && !c.version.endsWith('*'));
  const isLower = (c) => c.op === '>=' || c.op === '>';
  const hasPin = clauses.some(isPin);
  // A lower bound already above the fixed version: the specifier excludes the vulnerable version as it is.
  const lowerAbove = clauses.some((c) => isLower(c) && !satisfied(c));
  const out = []; // [{src: the clause as written, body: its operator, spacing and version from now on}]
  const keep = (c, op = c.op, version = c.version) => out.push({ src: c, body: `${op}${c.sp}${version}` });
  let raised = false;
  for (const c of clauses) {
    if (isPin(c)) keep(c, c.op, fixed);
    else if (isLower(c)) {
      if (hasPin ? satisfied(c) : lowerAbove) keep(c);
      else if (!hasPin && !raised) { raised = true; keep(c, '>=', fixed); }
    } else if (satisfied(c)) keep(c);
    else return null;
  }

  let spec;
  if (!clauses.length) spec = `>=${fixed}${text.slice(start, end)}`;
  else {
    const first = clauses[0], last = clauses[clauses.length - 1];
    if (!hasPin && !raised && !lowerAbove) {
      // Spaced like the clauses already there: '~= 3.2.0' -> '~= 3.2.0, >= 3.2.25'.
      const sp = clauses.find((c) => c.sp && !/[\\\r\n]/.test(c.sp))?.sp || '';
      const spaced = clauses.length > 1 ? /^[ \t]/.test(clauses[1].lead) : !!sp;
      out.push({ src: { lead: spaced ? ' ' : '', trail: '' }, body: `>=${sp}${fixed}` });
    }
    // The first and last pieces keep the whitespace around the whole specifier (before a marker, a continuation...).
    spec = out.map(({ src, body }, i) => `${i === 0 ? first.lead : src.lead}${body}${i === out.length - 1 ? last.trail : src === last ? '' : src.trail}`).join(',');
  }
  const result = text.slice(0, start) + spec + text.slice(end);
  if (result === text || !specifierMatches(spec.replace(/\\[ \t]*\r?\n/g, ' '), fixed)) return null;
  return result;
}

// The quick fix's rewrite of the text an editor holds for a checked requirement, after making sure it is still that
// requirement: requirements.txt text (from the name to the end of its continuation lines) must read as `raw` again;
// a pyproject.toml dependency string must be `raw`. Other files (Pipfile, Poetry tables) get no rewrite.
function upgradeSource({ kind, text, raw, fixed } = {}) {
  if (typeof text !== 'string' || typeof raw !== 'string' || !raw) return null;
  const as = kind === 'requirements' ? deps.parseRequirementsTxt(text).reqs[0]?.raw : kind === 'pyproject' ? text.trim() : null;
  return as === raw ? upgradeRequirement(text, fixed) : null;
}

module.exports = { keyOf, cmpVersion, requirementVersion, parseLock, isAffected, fixedVersions, firstFixed, summarize, upgradeRequirement, upgradeSource };
