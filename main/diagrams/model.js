// Class diagram model: turns the per-file facts that diagram_model.py reads with `ast` into classes with resolved
// bases and associations. Pure functions (no fs), so verify/diagrams.mjs can check them from Node as well.
//
// A file is known under every module name Python could import it by: the package chain (the folders above it that
// hold an __init__.py), its path from the project root, and its path from <root>/src (src layout; namespace packages
// without __init__.py). Names resolve the way Python binds them: classes defined in the module, `import a.b`,
// `import a.b as x`, `from m import n as x` (absolute or relative), `from m import *`, and module-level aliases
// (`Alias = Shape`), following re-exports through other modules (a package's __init__.py) up to a fixed depth.
const path = require('path');

const ENUM_BASES = new Set(['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag', 'ReprEnum']);
const MAX_DEPTH = 12;

// Module names for a file. existsInit(dir) says whether dir holds an __init__.py.
function moduleNames(file, root, existsInit) {
  const names = [];
  const stem = path.basename(file).replace(/\.pyi?$/i, '');
  const isInit = stem === '__init__';
  let dir = path.dirname(file);
  const parts = isInit ? [] : [stem];
  for (let guard = 0; guard < 64 && existsInit(dir); guard++) {
    parts.unshift(path.basename(dir));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (parts.length) names.push(parts.join('.'));
  for (const base of root ? [path.join(root, 'src'), root] : []) {
    const rel = path.relative(base, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segs = rel.split(/[\\/]/);
    segs[segs.length - 1] = stem;
    if (isInit) segs.pop();
    if (segs.length && segs.every((s) => /^[A-Za-z_]\w*$/.test(s))) names.push(segs.join('.'));
  }
  return [...new Set(names)];
}

const isPackageFile = (file) => /^__init__\.pyi?$/i.test(path.basename(file));

// files: [{path, modules: [names] (first is canonical), info: {imports, classes} | null, inScope}].
// Returns {classes, edges, missing: [module names looked up but not parsed]}.
function buildModel(files) {
  const byModule = new Map();
  const recs = [];
  const missing = new Set();
  for (const f of files) {
    if (!f.info) continue;
    const rec = {
      file: f, module: f.modules[0] || path.basename(f.path).replace(/\.pyi?$/i, ''), isPackage: isPackageFile(f.path),
      top: new Map(), byQual: new Map(), bindings: new Map(), stars: [],
    };
    for (const c of f.info.classes) {
      rec.byQual.set(c.qualname, c);
      if (!c.qualname.includes('.')) rec.top.set(c.name, c);
    }
    recs.push(rec);
    for (const m of f.modules) if (!byModule.has(m)) byModule.set(m, rec);
  }

  // The package a relative import starts from.
  const relativeBase = (rec, level) => {
    let parts = rec.module.split('.');
    if (!rec.isPackage) parts = parts.slice(0, -1);
    if (level > 1) parts = parts.slice(0, Math.max(0, parts.length - (level - 1)));
    return parts.join('.');
  };
  for (const rec of recs) {
    for (const imp of rec.file.info.imports) {
      if (imp.kind === 'import') {
        if (imp.as) rec.bindings.set(imp.as, { module: imp.module });
        else rec.bindings.set(imp.module.split('.')[0], { module: imp.module.split('.')[0] });
      } else if (imp.kind === 'from') {
        const base = imp.level ? relativeBase(rec, imp.level) : '';
        const mod = [base, imp.module].filter(Boolean).join('.');
        for (const n of imp.names) {
          if (n.name === '*') rec.stars.push(mod);
          else rec.bindings.set(n.as || n.name, { from: mod, name: n.name });
        }
      } else if (imp.kind === 'alias' && !rec.top.has(imp.name)) {
        rec.bindings.set(imp.name, { expr: imp.target });
      }
    }
  }

  const classRef = (rec, cls) => ({ kind: 'class', rec, cls });
  const moduleRef = (mod) => ({ kind: 'module', mod });

  function resolveIn(mod, name, depth) {
    if (depth > MAX_DEPTH) return null;
    const rec = byModule.get(mod);
    if (rec) {
      const c = rec.top.get(name);
      if (c) return classRef(rec, c);
      const b = rec.bindings.get(name);
      if (b) {
        const r = resolveBinding(rec, b, depth + 1);
        if (r) return r;
      }
      for (const star of rec.stars) {
        const r = resolveIn(star, name, depth + 1);
        if (r) return r;
      }
    } else if (mod) missing.add(mod);
    const sub = mod ? `${mod}.${name}` : name;
    if (byModule.has(sub)) return moduleRef(sub);
    if (rec) missing.add(sub);
    return null;
  }

  function resolveBinding(rec, b, depth) {
    if (b.module) {
      if (!byModule.has(b.module)) missing.add(b.module);
      return moduleRef(b.module);
    }
    if (b.from !== undefined) return resolveIn(b.from, b.name, depth);
    if (b.expr) return resolveDotted(rec, b.expr, depth);
    return null;
  }

  function resolveDotted(rec, dotted, depth = 0) {
    if (!dotted || depth > MAX_DEPTH) return null;
    const parts = dotted.split('.');
    let cur = null;
    const first = parts[0];
    if (rec.top.has(first)) cur = classRef(rec, rec.top.get(first));
    else if (rec.bindings.has(first)) cur = resolveBinding(rec, rec.bindings.get(first), depth + 1);
    else {
      for (const star of rec.stars) {
        cur = resolveIn(star, first, depth + 1);
        if (cur) break;
      }
    }
    for (let i = 1; cur && i < parts.length; i++) {
      if (cur.kind === 'module') cur = resolveIn(cur.mod, parts[i], depth + 1);
      else {
        const nested = cur.rec.byQual.get(`${cur.cls.qualname}.${parts[i]}`);
        cur = nested ? classRef(cur.rec, nested) : null;
      }
    }
    return cur?.kind === 'class' ? cur : null;
  }

  const idOf = (rec, cls) => `${rec.file.path}::${cls.qualname}`;
  const classes = [];
  const byId = new Map();
  const edges = [];
  for (const rec of recs) {
    for (const c of rec.file.info.classes) {
      const id = idOf(rec, c);
      const out = {
        id, name: c.name, qualname: c.qualname, module: rec.module, path: rec.file.path, line: c.line, col: c.col,
        endLine: c.endLine, inScope: !!rec.file.inScope, bases: [], externalBases: [], dataclass: !!c.dataclass,
        decorators: c.decorators, metaclass: c.metaclass, fields: c.fields, methods: c.methods,
      };
      for (const b of c.bases) {
        const r = resolveDotted(rec, b);
        if (r && idOf(r.rec, r.cls) !== id) out.bases.push(idOf(r.rec, r.cls));
        else if (!r) out.externalBases.push(b);
      }
      out._rec = rec;
      classes.push(out);
      byId.set(id, out);
    }
  }
  // Enum-ness and abstractness come down the project hierarchy too (class Color(BaseEnum) where BaseEnum(Enum)).
  const memo = new Map();
  const flags = (c, seen = new Set()) => {
    if (memo.has(c.id)) return memo.get(c.id);
    if (seen.has(c.id)) return { enum: false, protocol: false };
    seen.add(c.id);
    const ext = c.externalBases.map((b) => b.split('.').pop());
    const f = { enum: ext.some((b) => ENUM_BASES.has(b)), protocol: ext.includes('Protocol') };
    for (const b of c.bases) {
      const p = byId.get(b);
      if (p && flags(p, seen).enum) f.enum = true;
    }
    memo.set(c.id, f);
    return f;
  };
  for (const c of classes) {
    const f = flags(c);
    const ext = c.externalBases.map((b) => b.split('.').pop());
    const abstract = ext.includes('ABC') || (c.metaclass || '').split('.').pop() === 'ABCMeta' || c.methods.some((m) => m.abstract);
    c.stereotype = f.enum ? 'enum' : c.dataclass ? 'dataclass' : f.protocol ? 'protocol' : abstract ? 'abstract' : '';
    c.abstract = abstract;
    c.fields = c.fields.map((fl) => ({
      ...fl,
      kind: f.enum && fl.kind === 'class' && !/^__.*__$/.test(fl.name) && !/^_(ignore|order)_$/.test(fl.name) ? 'enum'
        : c.dataclass && fl.kind === 'annotated' ? 'dataclass' : fl.kind,
    }));
    for (const b of c.bases) edges.push({ from: c.id, to: b, kind: 'extends' });
    // Associations: attribute annotations that name project classes, one edge per target (labels joined).
    const assoc = new Map();
    for (const fl of c.fields) {
      for (const ref of fl.refs || []) {
        const r = resolveDotted(c._rec, ref.name);
        if (!r) continue;
        const to = idOf(r.rec, r.cls);
        if (to === c.id) continue;
        const e = assoc.get(to) || { from: c.id, to, kind: 'assoc', labels: [], many: false };
        if (!e.labels.includes(fl.name)) e.labels.push(fl.name);
        e.many ||= ref.many;
        assoc.set(to, e);
      }
    }
    for (const e of assoc.values()) edges.push({ from: e.from, to: e.to, kind: 'assoc', label: e.labels.join(', '), many: e.many });
  }
  for (const c of classes) {
    delete c._rec;
    c.fields = c.fields.map(({ refs, ...rest }) => rest);
  }
  return { classes, edges, missing: [...missing] };
}

// Where a module name could live under the given source roots: [file paths to try].
function candidateFiles(mod, roots) {
  const segs = mod.split('.');
  if (!segs.every((s) => /^[A-Za-z_]\w*$/.test(s))) return [];
  return roots.flatMap((r) => [path.join(r, ...segs) + '.py', path.join(r, ...segs, '__init__.py')]);
}

module.exports = { moduleNames, buildModel, candidateFiles, ENUM_BASES };
