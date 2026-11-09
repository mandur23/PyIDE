// Spring Boot configuration files, as IntelliJ IDEA and VS Code's Spring Boot Tools support them: in a Spring Boot
// module, application*.properties and bootstrap*.properties complete property keys (with the type, default and
// description) and known values (booleans, enums, hints such as spring.jpa.hibernate.ddl-auto, log levels under
// logging.level.*), show a key's description on hover, and warn about deprecated and unknown keys, with the key an
// unknown one probably meant as a quick fix. application*.yml and .yaml get the same through the data-formats plugin's
// YAML engine, with a schema built from the same metadata. The metadata comes from main/features/spring-config.js: the
// module's own jars in the Maven or Gradle cache, or the bundled metadata until they are there; the bundled one may be
// another Spring Boot version, so it warns only where it is sure.
(() => {
  const monaco = ide.monaco;
  if (!monaco) return;
  const { basename } = ide.util;
  const OWNER = 'spring-config';
  const CONFIG = /^(?:application|bootstrap)(?:-[\w.-]+)?\.(properties|ya?ml)$/i;
  const BUILD = /^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|libs\.versions\.toml|(?:additional-)?spring-configuration-metadata\.json)$/i;
  const K = monaco.languages.CompletionItemKind;

  const fileOf = (model) => (model.uri.scheme === 'file' ? model.uri.fsPath : null);
  const kindOf = (model) => {
    const p = !model.isDisposed() && fileOf(model);
    const m = p && CONFIG.exec(basename(p));
    return m ? (m[1].toLowerCase() === 'properties' ? 'properties' : 'yaml') : null;
  };

  // ---------- metadata ----------
  // path -> {promise, meta}: meta is null outside a Spring Boot module.
  const cache = new Map();
  let generation = 0;
  function prepare(raw) {
    if (!raw) return null;
    const byName = new Map(raw.properties.map((p) => [p.name, p]));
    const maps = raw.properties.filter((p) => p.map).sort((a, b) => b.name.length - a.name.length);
    // Where an unknown key is warned about. The module's own metadata is its whole classpath: any key in a namespace
    // it knows (spring., server., acme.). The bundled metadata may be another version and lists some modules only in
    // part: only below a prefix its complete modules have (spring.application., not spring.cloud. or spring.flyway.).
    const project = raw.source === 'project';
    const tops = new Set();
    const prefixes = new Set();
    for (const p of raw.properties) {
      const parts = p.name.split('.');
      tops.add(parts[0]);
      if (!p.partial) for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('.'));
    }
    const checked = (c) => (project ? tops.has(c.split('.')[0]) : prefixes.has(c.slice(0, c.lastIndexOf('.'))));
    const names = raw.properties.filter((p) => !p.map && p.deprecation?.level !== 'error').map((p) => p.name);
    return { ...raw, byName, maps, names, checked, project };
  }
  function load(path, again = false) {
    const key = path.toLowerCase();
    let c = cache.get(key);
    if (c && !again) return c.promise;
    const gen = generation;
    const next = { promise: null, meta: c?.meta };
    next.promise = ide.api.invoke('spring:configMetadata', path).then(prepare, () => null).then((meta) => {
      if (gen !== generation && cache.get(key) !== next) return meta;
      const changed = JSON.stringify(meta && [meta.source, meta.properties.length, meta.boot]) !== JSON.stringify(next.meta && [next.meta.source, next.meta.properties.length, next.meta.boot]);
      next.meta = meta;
      if (changed || !c) {
        for (const m of monaco.editor.getModels()) if (fileOf(m)?.toLowerCase() === key) schedule(m);
        ide.dataFormats?.revalidate?.();
      }
      return meta;
    });
    cache.set(key, next);
    return next.promise;
  }
  const metaNow = (model) => cache.get(fileOf(model)?.toLowerCase())?.meta || null;
  async function metaFor(model) {
    const p = fileOf(model);
    return p ? load(p) : null;
  }
  // A build file changed, the window came back (a build may have filled the cache): ask again.
  function refresh() {
    generation++;
    for (const m of monaco.editor.getModels()) if (kindOf(m)) load(fileOf(m), true);
  }
  ide.on('fileSaved', (tab) => { if (tab?.path && BUILD.test(basename(tab.path))) refresh(); });
  window.addEventListener('focus', () => { if (cache.size) refresh(); });

  // ---------- names and text ----------
  // Spring Boot's relaxed binding: serverPort, server_port and server-port are one property; the canonical form is
  // lowercase kebab-case.
  const canon = (key) => key.split('.').map((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()).join('.');
  // The property a key sets: itself, a map entry (logging.level.org.example) or a list element (x[0]).
  function lookup(meta, key) {
    if (!key) return null;
    const c = canon(key);
    const p = meta.byName.get(key) || meta.byName.get(c) || meta.byName.get(c.replace(/\[\d+\]/g, ''));
    if (p) return { prop: p };
    for (const m of meta.maps) {
      if (c.startsWith(`${m.name}.`) || c.startsWith(`${m.name}[`)) return { prop: m, mapKey: key.slice(m.name.length + 1) };
    }
    return null;
  }
  // java.util.Map<java.lang.String,java.lang.String> -> Map<String, String>
  const shortType = (t) => (t ? t.replace(/(?:[a-z_]\w*\.)+/g, '').replace(/\$/g, '.').replace(/,\s*/g, ', ') : '');
  const md = (value) => ({ value, isTrusted: false });
  const code = (s) => `\`${String(s).replace(/`/g, '\'')}\``;
  // "Deprecated. Use x instead. Reason", or with named: "Property y is deprecated. …"
  function deprecationText(p, named = false) {
    const d = p.deprecation;
    if (!d) return '';
    const head = named
      ? (d.level === 'error' ? tr('Property {name} is no longer supported.', { name: p.name }) : tr('Property {name} is deprecated.', { name: p.name }))
      : (d.level === 'error' ? tr('No longer supported.') : tr('Deprecated.'));
    return [head, d.replacement && tr('Use {name} instead.', { name: named ? d.replacement : code(d.replacement) }), d.reason].filter(Boolean).join(' ');
  }
  function describe(p, { title = true, dflt = true } = {}) {
    const parts = [];
    if (title) parts.push(`**${p.name}**${p.type ? ` ${code(shortType(p.type))}` : ''}`);
    if (p.deprecation) parts.push(`*${deprecationText(p)}*`);
    if (p.description) parts.push(p.description);
    if (dflt && p.default !== undefined) parts.push(tr('Default: {value}', { value: code(p.default) }));
    if (p.values?.length && p.values.length <= 20) parts.push(tr('Values: {values}', { values: p.values.map((v) => code(v.value)).join(', ') }));
    return parts.join('\n\n');
  }

  // ---------- .properties ----------
  // A line's key and value: the key ends at an unescaped "=", ":" or blank; the separator may have blanks around it.
  function parseLine(text) {
    const ks = /^[ \t\f]*/.exec(text)[0].length;
    if (ks >= text.length) return null;
    if (text[ks] === '#' || text[ks] === '!') return { comment: true };
    let i = ks;
    while (i < text.length && !/[=: \t\f]/.test(text[i])) i += text[i] === '\\' ? 2 : 1;
    const keyEnd = Math.min(i, text.length);
    let j = keyEnd;
    while (j < text.length && /[ \t\f]/.test(text[j])) j++;
    let sep = -1;
    if (text[j] === '=' || text[j] === ':') {
      sep = j++;
      while (j < text.length && /[ \t\f]/.test(text[j])) j++;
    }
    return { keyStart: ks, keyEnd, key: text.slice(ks, keyEnd).replace(/\\(.)/g, '$1'), sep, valueStart: sep >= 0 || j > keyEnd ? j : -1 };
  }
  const continues = (text) => /(?:^|[^\\])(?:\\\\)*\\$/.test(text);
  // Whether line n (1-based) continues the value of the line before it.
  function isContinuation(model, n) {
    let k = n - 1;
    while (k >= 1) {
      const t = model.getLineContent(k);
      if (!continues(t)) return false;
      if (k === 1 || !isContinuation(model, k)) return !parseLine(t)?.comment;
      k--;
    }
    return false;
  }
  const keysIn = (model) => {
    const out = new Map();
    for (let n = 1; n <= model.getLineCount(); n++) {
      const l = parseLine(model.getLineContent(n));
      if (l && !l.comment && !isContinuation(model, n)) out.set(n, l);
    }
    return out;
  };

  const LANGS = ['ini', 'properties', 'plaintext'];
  const retrigger = { id: 'editor.action.triggerSuggest', title: '' };
  monaco.languages.registerCompletionItemProvider(LANGS, {
    triggerCharacters: ['.', '=', ':', ','],
    async provideCompletionItems(model, position) {
      if (kindOf(model) !== 'properties') return undefined;
      const version = model.getVersionId();
      const meta = await metaFor(model);
      if (!meta || model.isDisposed() || model.getVersionId() !== version) return undefined;
      const n = position.lineNumber;
      const text = model.getLineContent(n);
      const col = position.column - 1;
      if (isContinuation(model, n)) return undefined;
      const l = parseLine(text) || { keyStart: col, keyEnd: col, key: '', sep: -1, valueStart: -1 };
      if (l.comment) return undefined;
      const suggestions = [];
      // The key.
      if (col <= l.keyEnd && col >= l.keyStart) {
        const range = new monaco.Range(n, l.keyStart + 1, n, l.keyEnd + 1);
        const hasSep = l.sep >= 0 || l.valueStart >= 0;
        const present = new Set([...keysIn(model).entries()].filter(([line]) => line !== n).map(([, x]) => canon(x.key)));
        const add = (name, p, { doc, sort = '1', insert, again } = {}) => {
          const deprecated = !!p.deprecation;
          suggestions.push({
            label: { label: name, description: shortType(p.type) },
            kind: K.Property,
            detail: [shortType(p.type), p.default !== undefined && `= ${p.default}`].filter(Boolean).join(' ') || undefined,
            documentation: md(doc ?? describe(p, { title: false })),
            insertText: insert ?? (hasSep ? name : `${name}=`),
            filterText: name,
            range,
            sortText: `${deprecated ? '9' : sort}${name}`,
            ...(deprecated && { tags: [monaco.languages.CompletionItemTag.Deprecated] }),
            ...((again ?? (!hasSep && p.values?.length)) && { command: retrigger }),
          });
        };
        for (const p of meta.properties) {
          if (p.deprecation?.level === 'error' || (present.has(p.name) && !p.map)) continue;
          if (!p.map) { add(p.name, p); continue; }
          // A map: its known keys (logging.level.root), and the prefix to type one's own after.
          add(`${p.name}.`, p, { insert: `${p.name}.`, again: true });
          for (const k of p.keys || []) {
            const name = `${p.name}.${k.value}`;
            if (!present.has(canon(name))) add(name, p, { doc: [k.description, describe(p, { title: false })].filter(Boolean).join('\n\n'), sort: '0' });
          }
        }
        return { suggestions };
      }
      // The value (a list's current item).
      if (l.valueStart < 0 || col < l.valueStart) return undefined;
      const hit = lookup(meta, l.key);
      const values = hit?.prop.values;
      if (!values?.length) return undefined;
      const comma = text.lastIndexOf(',', col - 1);
      let start = Math.max(l.valueStart, comma + 1);
      while (start < col && /\s/.test(text[start])) start++;
      const rest = text.slice(col);
      const end = col + (/^[^,]*/.exec(rest)[0].replace(/\s+$/, '').length);
      const range = new monaco.Range(n, start + 1, n, end + 1);
      values.forEach((v, i) => suggestions.push({
        label: v.value, kind: K.EnumMember, insertText: v.value, range, filterText: v.value,
        sortText: String(i).padStart(4, '0'),
        ...(v.description && { documentation: md(v.description) }),
      }));
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(LANGS, {
    async provideHover(model, position) {
      if (kindOf(model) !== 'properties') return undefined;
      const meta = await metaFor(model);
      if (!meta || model.isDisposed()) return undefined;
      const n = position.lineNumber;
      if (isContinuation(model, n)) return undefined;
      const l = parseLine(model.getLineContent(n));
      const col = position.column - 1;
      if (!l || l.comment || col < l.keyStart || col > l.keyEnd) return undefined;
      const hit = lookup(meta, l.key);
      if (!hit) return undefined;
      const key = hit.prop.keys?.find((k) => k.value === hit.mapKey);
      const contents = [md(describe(hit.prop)), ...(key?.description ? [md(`${code(hit.mapKey)}: ${key.description}`)] : [])];
      return { range: new monaco.Range(n, l.keyStart + 1, n, l.keyEnd + 1), contents };
    },
  });

  // Edit distance, or limit + 1 once it is sure to be more.
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, row[j]);
      }
      if (best > limit) return limit + 1;
      prev = row;
    }
    return prev[b.length];
  }
  // The known keys an unknown one probably meant, best first: a typo of one (server.prot -> server.port), then the ones
  // with its last segment, shortest first (spring.application.port -> server.port).
  function suggestionsFor(meta, key) {
    const c = canon(key);
    const limit = Math.max(1, Math.min(3, Math.floor(c.length / 5)));
    const typos = meta.names.map((n) => [n, distance(c, n, limit)]).filter(([, d]) => d <= limit)
      .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length).map(([n]) => n);
    const last = c.slice(c.lastIndexOf('.') + 1);
    const same = meta.names.filter((n) => n.slice(n.lastIndexOf('.') + 1) === last)
      .sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length);
    return [...new Set([...typos, ...same])].slice(0, 3);
  }

  // Warnings: deprecated keys, and unknown keys where the metadata can tell (see prepare), with the keys they probably
  // meant as quick fixes. Spring Boot ignores an unknown key without a word, so spring.application.port=80 runs on
  // 8080. A map entry (logging.level.com.example), a placeholder and a key in no known namespace (the application's
  // own app.title) are left alone.
  const fixes = new WeakMap(); // model -> [{line, start, end, names}]
  function validate(model) {
    if (model.isDisposed()) return;
    const meta = kindOf(model) === 'properties' ? metaNow(model) : null;
    const markers = [];
    const found = [];
    for (const [n, l] of meta ? keysIn(model) : []) {
      if (!l.key || l.key.includes('${')) continue;
      const warn = (message) => markers.push({ severity: monaco.MarkerSeverity.Warning, message, source: 'Spring Boot',
        startLineNumber: n, startColumn: l.keyStart + 1, endLineNumber: n, endColumn: l.keyEnd + 1 });
      const hit = lookup(meta, l.key);
      if (hit?.prop.deprecation && !hit.mapKey && meta.project) {
        warn(deprecationText(hit.prop, true));
        if (hit.prop.deprecation.replacement) found.push({ line: n, start: l.keyStart, end: l.keyEnd, names: [hit.prop.deprecation.replacement] });
      } else if (!hit && meta.checked(canon(l.key))) {
        const names = suggestionsFor(meta, l.key);
        const parts = [tr('Unknown Spring Boot property: {name}', { name: l.key })];
        if (names.length) parts.push(tr('Did you mean {name}?', { name: names[0] }));
        if (!meta.project) parts.push(tr('(checked against the Spring Boot {version} metadata bundled with the app)', { version: meta.bundled || '' }));
        warn(parts.join(' '));
        if (names.length) found.push({ line: n, start: l.keyStart, end: l.keyEnd, names });
      }
    }
    fixes.set(model, found);
    monaco.editor.setModelMarkers(model, OWNER, markers);
  }
  const fixesAt = (model, range) => (fixes.get(model) || []).filter((f) => f.line >= range.startLineNumber && f.line <= range.endLineNumber);
  monaco.languages.registerCodeActionProvider(LANGS, {
    provideCodeActions(model, range, context) {
      if (kindOf(model) !== 'properties') return undefined;
      const actions = [];
      for (const f of fixesAt(model, range)) {
        const diagnostics = context.markers.filter((m) => m.owner === OWNER && m.startLineNumber === f.line);
        const r = new monaco.Range(f.line, f.start + 1, f.line, f.end + 1);
        f.names.forEach((name, i) => actions.push({
          title: tr('Replace with {name}', { name }), kind: 'quickfix', isPreferred: i === 0, diagnostics,
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: r, text: name } }] },
        }));
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });
  // Alt+Enter on such a key, as on other problems.
  const focused = () => monaco.editor.getEditors().find((e) => e.hasTextFocus());
  const caretOnFix = () => {
    const e = focused();
    const p = e?.getPosition();
    return !!p && kindOf(e.getModel()) === 'properties'
      && fixesAt(e.getModel(), new monaco.Range(p.lineNumber, 1, p.lineNumber, 1)).some((f) => p.column - 1 >= f.start && p.column - 1 <= f.end);
  };
  ide.registerAction?.({ id: 'SpringConfig.ShowActions', title: tr('Show Context Actions'), keys: 'Alt+Enter', when: caretOnFix,
    run: () => focused()?.trigger('spring-config', 'editor.action.quickFix', null) });
  const timers = new WeakMap();
  function schedule(model) {
    if (model.isDisposed()) return;
    clearTimeout(timers.get(model));
    timers.set(model, setTimeout(() => validate(model), 250));
  }
  function watch(model) {
    if (!kindOf(model)) return;
    metaFor(model);
    model.onDidChangeContent(() => schedule(model));
    model.onWillDispose(() => { clearTimeout(timers.get(model)); monaco.editor.setModelMarkers(model, OWNER, []); });
    schedule(model);
  }
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);

  // ---------- YAML ----------
  // The dotted names as nested mappings, closed (their unknown keys warned about by data-formats) where .properties
  // would warn; keys spelled in camelCase, snake_case or [brackets] are let through unchecked.
  const LOOSE = { '[A-Z_\\[]': {} };
  function yamlSchema(meta) {
    const node = () => ({ type: 'object', properties: {} });
    const root = node();
    const leaf = (p) => {
      // data-formats' hover adds the default.
      const description = describe(p, { title: false, dflt: false });
      const examples = p.values?.map((v) => v.value);
      const base = { description: [p.type && tr('Type: {type}', { type: code(shortType(p.type)) }), description].filter(Boolean).join('\n\n'),
        ...(p.default !== undefined && { default: p.default }) };
      if (!p.map) return { ...base, ...(examples?.length && { examples }) };
      const value = examples?.length ? { examples } : {};
      const properties = Object.fromEntries((p.keys || []).map((k) => [k.value, { ...(k.description && { description: k.description }), ...value }]));
      return { ...base, type: 'object', properties, additionalProperties: value };
    };
    for (const p of meta.properties) {
      if (p.deprecation?.level === 'error') continue;
      const parts = p.name.split('.');
      let cur = root;
      for (const seg of parts.slice(0, -1)) {
        let next = cur.properties[seg];
        if (!next?.properties) next = cur.properties[seg] = { ...next, ...node() };
        cur = next;
      }
      const last = parts[parts.length - 1];
      const prev = cur.properties[last];
      cur.properties[last] = prev?.properties && !p.map ? { ...prev, description: prev.description || leaf(p).description } : leaf(p);
    }
    // A mapping is closed where .properties warns about an unknown key below it (meta.checked); the root never is.
    const close = (n, path) => {
      for (const [k, child] of Object.entries(n.properties || {})) {
        if (!child.properties) continue;
        const p = path ? `${path}.${k}` : k;
        if (child.additionalProperties === undefined && meta.checked(`${p}.x`)) Object.assign(child, { additionalProperties: false, patternProperties: LOOSE });
        close(child, p);
      }
    };
    close(root, '');
    return root;
  }
  const schemas = new WeakMap(); // meta -> schema
  function schemaOf(model) {
    if (kindOf(model) !== 'yaml') return null;
    const p = fileOf(model);
    const c = cache.get(p.toLowerCase());
    if (!c) { load(p); return null; }
    if (!c.meta) return null;
    if (!schemas.has(c.meta)) schemas.set(c.meta, yamlSchema(c.meta));
    return schemas.get(c.meta);
  }
  // data-formats loads its YAML engine with a script tag of its own, which can run after every plugin (and 'ready').
  const isYaml = (p) => CONFIG.test(decodeURIComponent(p.slice(p.lastIndexOf('/') + 1))) && /\.ya?ml$/i.test(p);
  function hookYaml(tries = 0) {
    const df = ide.dataFormats;
    if (df?.addYamlSchema) df.addYamlSchema(isYaml, schemaOf);
    else if (df && tries < 100) setTimeout(() => hookYaml(tries + 1), 100);
  }
  ide.on('ready', () => hookYaml());

  ide.springConfig = { metadata: (path) => load(path), refresh };
})();
