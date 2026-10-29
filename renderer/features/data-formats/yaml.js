// YAML for the data-formats plugin: a line-based reading of block mappings and sequences (by indentation, with plain,
// quoted and block scalars and flow collections kept whole), used for schema-based completion, hover and validation of
// well-known files and for Reformat Code. Monaco has no YAML language service; this is not a full YAML parser, so
// whatever it cannot read safely it leaves alone (no markers there, no reformatting of the file).
(() => {
  const monaco = ide.monaco;
  const df = ide.dataFormats;
  const K = monaco.languages.CompletionItemKind;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const OWNER = 'data-formats';

  // ---------- line scanner ----------
  const sep = (t, i) => i >= t.length || t[i] === ' ' || t[i] === '\t';
  const trimEnd = (t, e) => { while (e > 0 && (t[e - 1] === ' ' || t[e - 1] === '\t')) e--; return e; };
  // The closing quote at or after i (a quote doubled in '…' and a backslash escape in "…" do not close), or -1.
  function quoteEnd(t, i, q) {
    for (let k = i; k < t.length; k++) {
      if (q === '"' && t[k] === '\\') { k++; continue; }
      if (t[k] === q) {
        if (q === "'" && t[k + 1] === "'") { k++; continue; }
        return k;
      }
    }
    return -1;
  }
  // Brackets of a flow collection ([…], {…}) from i on, quotes respected; st = {depth, quote} carries over lines.
  function flowScan(t, i, st) {
    let { depth, quote } = st;
    for (let k = i; k < t.length; k++) {
      const c = t[k];
      if (quote) {
        if (quote === '"' && c === '\\') { k++; continue; }
        if (c === quote) {
          if (quote === "'" && t[k + 1] === "'") { k++; continue; }
          quote = null;
        }
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (k === 0 || t[k - 1] === ' ' || t[k - 1] === '\t')) break;
      else if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && --depth === 0) return { depth, quote, end: k };
    }
    return { depth, quote, end: -1 };
  }
  // A comment starts with # at i or later, after whitespace (or at the start of the line).
  function commentFrom(t, i) {
    for (let k = i; k < t.length; k++) if (t[k] === '#' && (k === 0 || t[k - 1] === ' ' || t[k - 1] === '\t')) return k;
    return -1;
  }
  const unquote = (v) => {
    if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") return v.slice(1, -1).replace(/''/g, "'");
    if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
    return v;
  };
  const keyName = (raw) => unquote(raw.replace(/^(?:[&!]\S*\s+)+/, ''));

  // A value from v on: {start, end (before a comment and trailing blanks), comment (index or -1), kind}: kind is empty
  // (nothing, or only an anchor or tag: the value follows on the next lines), block (| or > header), quoted,
  // quote-open (a quoted scalar that goes on to the next lines), flow, flow-open, or plain.
  function scanValue(t, v) {
    const r = { start: v, end: v, comment: -1, kind: 'empty', props: false };
    let p = v;
    while (p < t.length && (t[p] === '&' || t[p] === '!')) {
      while (p < t.length && !sep(t, p)) p++;
      while (t[p] === ' ' || t[p] === '\t') p++;
      r.props = true;
    }
    if (p >= t.length || t[p] === '#') {
      r.comment = p < t.length ? p : -1;
      r.end = trimEnd(t, p);
      return r;
    }
    const c = t[p];
    const tail = (from) => {
      r.comment = commentFrom(t, from);
      r.end = trimEnd(t, r.comment >= 0 ? r.comment : t.length);
      return r;
    };
    if (c === '|' || c === '>') {
      const m = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?/.exec(t.slice(p))[0];
      const after = p + m.length;
      if (sep(t, after) && /^\s*(#.*)?$/.test(t.slice(after))) {
        Object.assign(r, { kind: 'block', chomp: m.includes('-') ? '-' : m.includes('+') ? '+' : '', explicit: /\d/.test(m) });
        return tail(after);
      }
    }
    if (c === '"' || c === "'") {
      const e = quoteEnd(t, p + 1, c);
      if (e < 0) return Object.assign(r, { kind: 'quote-open', quote: c, end: t.length });
      r.kind = 'quoted';
      return tail(e + 1);
    }
    if (c === '[' || c === '{') {
      const st = flowScan(t, p, { depth: 0, quote: null });
      if (st.end < 0) return Object.assign(r, { kind: 'flow-open', st, end: t.length });
      r.kind = 'flow';
      return tail(st.end + 1);
    }
    r.kind = 'plain';
    return tail(p);
  }

  // A mapping key at i: {start, end, colon, vStart, name} or null. Plain keys end at the first ": " (or a ":" that ends
  // the line); quoted keys at their closing quote.
  function findKey(t, i) {
    const c = t[i];
    let end;
    let colon = -1;
    if (c === '"' || c === "'") {
      const q = quoteEnd(t, i + 1, c);
      if (q < 0) return null;
      end = q + 1;
      let p = end;
      while (t[p] === ' ' || t[p] === '\t') p++;
      if (t[p] !== ':' || !sep(t, p + 1)) return null;
      colon = p;
    } else {
      if ('[{|>*'.includes(c)) return null;
      for (let k = i; k < t.length; k++) {
        if (t[k] === '#' && k > i && (t[k - 1] === ' ' || t[k - 1] === '\t')) return null;
        if (t[k] === ':' && sep(t, k + 1)) { colon = k; break; }
      }
      if (colon < 0) return null;
      end = trimEnd(t, colon);
      if (end <= i) return null;
    }
    let vStart = colon + 1;
    while (t[vStart] === ' ' || t[vStart] === '\t') vStart++;
    return { start: i, end, colon, vStart, name: keyName(t.slice(i, end)) };
  }

  // One line: kind blank, comment, doc (--- or ...), directive (%YAML) or content. Content has its indentation (spaces),
  // its list dashes (columns), body (where the item's content starts), key and value.
  function scanLine(t) {
    const indent = /^ */.exec(t)[0].length;
    const s = { indent, kind: 'content' };
    const rest = t.slice(indent);
    if (!rest.trim()) return { ...s, kind: 'blank' };
    if (rest[0] === '#') return { ...s, kind: 'comment' };
    if (indent === 0 && /^(---|\.\.\.)(\s|$)/.test(t)) return { ...s, kind: 'doc', after: t.slice(3).trim() };
    if (indent === 0 && t[0] === '%') return { ...s, kind: 'directive' };
    if (rest[0] === '\t') s.tab = true;
    s.dashes = [];
    let i = indent;
    while (t[i] === '-' && sep(t, i + 1)) {
      s.dashes.push(i);
      i++;
      while (t[i] === ' ' || t[i] === '\t') { if (t[i] === '\t') s.tab = true; i++; }
    }
    s.body = i;
    if (i >= t.length || t[i] === '#') {
      s.empty = true;
      s.comment = i < t.length ? i : -1;
      return s;
    }
    if (t[i] === '?' && sep(t, i + 1)) return { ...s, complex: true };
    s.key = findKey(t, i);
    s.value = scanValue(t, s.key ? s.key.vStart : i);
    return s;
  }

  // ---------- structure ----------
  // Walks the lines with a stack of open block collections ({type: map|seq, oldCol, newCol, path…}). For each line:
  // out[n] = {role: blank|comment|doc|keep|content|block|cont|bad, newIndent…}, where newIndent is the indentation the
  // line gets when nested collections indent by `unit`; entries = keys, list items and scalars with their paths
  // (['jobs', 'build', 'steps', 0, 'uses']). error = {line, why} for a line the formatter must not touch; lenient
  // (completion, validation) skips such lines instead.
  function walk(lines, { unit = 2, lenient = false } = {}) {
    const out = new Array(lines.length);
    const entries = [];
    const frames = [];
    let cont = null;
    let error = null;
    const fail = (n, why) => {
      if (lenient) out[n] = { role: 'bad' };
      else error = { line: n + 1, why };
    };
    // A block scalar's content: its indentation (of the first non-blank line, if deeper than the owner) and whether
    // every line has at least that much (else the content is invalid YAML, and only moves along with its owner).
    const blockContent = (n, ownerOld) => {
      let first = Infinity;
      let even = true;
      for (let m = n + 1; m < lines.length; m++) {
        if (!lines[m].trim()) continue;
        const ind = /^ */.exec(lines[m])[0].length;
        if (ind <= ownerOld) break;
        if (first === Infinity) first = ind;
        else if (ind < first) even = false;
      }
      return { first, even };
    };
    const startCont = (v, ownerOld, delta, n) => {
      switch (v.kind) {
        case 'block': {
          // The content goes one indentation deeper than its key (or dash), its own relative indentation kept.
          const { first, even } = blockContent(n, ownerOld);
          const shift = first !== Infinity && even && !v.explicit ? ownerOld + delta + unit - first : delta;
          return { kind: 'block', ownerOld, delta: shift, chomp: v.chomp, contentIndent: first };
        }
        case 'plain': return { kind: 'plain', ownerOld, delta };
        case 'quote-open': return { kind: 'quote', quote: v.quote, delta, line: n };
        case 'flow-open': return { kind: 'flow', st: v.st, delta, line: n };
        default: return null;
      }
    };
    for (let n = 0; n < lines.length && !error; n++) {
      let t = lines[n];
      let s = scanLine(t);
      if (cont) {
        if (s.kind === 'doc') cont = null;
        else if (cont.kind === 'block') {
          if (s.kind === 'blank' || s.indent > cont.ownerOld) { out[n] = { role: 'block', delta: cont.delta, cont }; continue; }
          cont = null;
        } else if (cont.kind === 'plain') {
          if (s.kind === 'blank') { out[n] = { role: 'blank' }; continue; }
          if (s.kind !== 'comment' && s.indent > cont.ownerOld) { out[n] = { role: 'cont', delta: cont.delta }; continue; }
          cont = null;
        } else {
          let done;
          if (cont.kind === 'quote') done = quoteEnd(t, 0, cont.quote) >= 0;
          else {
            cont.st = flowScan(t, 0, cont.st);
            done = cont.st.end >= 0;
          }
          out[n] = { role: 'cont', delta: cont.delta, keep: true };
          if (done) cont = null;
          continue;
        }
      }
      if (s.kind === 'blank') { out[n] = { role: 'blank' }; continue; }
      if (s.kind === 'comment') { out[n] = { role: 'comment', indent: s.indent, frames: frames.map((f) => [f.oldCol, f.newCol]) }; continue; }
      if (s.kind === 'directive') { out[n] = { role: 'keep' }; continue; }
      if (s.kind === 'doc') {
        if (s.after && s.after[0] !== '#') { fail(n, 'document'); continue; }
        frames.length = 0;
        out[n] = { role: 'doc' };
        continue;
      }
      if (s.tab) { fail(n, 'tab'); continue; }
      if (s.complex) { fail(n, 'complex'); continue; }

      // Where the line goes: next to the collection at its column, into a new one under the pending key or item
      // above it, or (a list at the key's own column) into that key's sequence.
      const c = s.indent;
      const isItem = s.dashes.length > 0;
      let cut = frames.length;
      while (cut && frames[cut - 1].oldCol > c) cut--;
      let top = frames[cut - 1];
      if (top && top.oldCol === c && top.type === 'seq' && !isItem && top.zero) top = frames[--cut - 1];
      let plan = null;
      let fixed = false;
      if (top && top.oldCol === c) {
        if (top.type === 'seq') plan = isItem ? 'sibling' : null;
        else if (isItem) plan = top.pending ? 'zeroSeq' : null;
        else if (s.key) plan = 'sibling';
        // "key:value" where a key belongs is no key in YAML (and no valid document either): read as "key: value".
        else if (/^[A-Za-z_][\w.-]*:[^\s:/]/.test(t.slice(c)) && s.value?.kind === 'plain') {
          t = t.slice(0, c) + t.slice(c).replace(':', ': ');
          s = scanLine(t);
          fixed = true;
          plan = s.key ? 'sibling' : null;
        }
      } else if (!top || top.pending) plan = 'child';
      if (!plan) { fail(n, 'structure'); continue; }
      let newCol;
      if (plan === 'sibling') newCol = top.newCol;
      else newCol = top ? top.pendingNew + unit : 0;
      // Dashes are written "- " (one space): nested dashes and the item's content move with them.
      const dashNew = (s.dashes || []).map((d, k) => newCol + 2 * k);
      const bodyNew = newCol + 2 * dashNew.length;
      const bodyDelta = bodyNew - s.body;
      const dashDelta = isItem ? dashNew.at(-1) - s.dashes.at(-1) : 0;
      if (!lenient && s.value?.kind === 'block' && s.value.explicit && (bodyDelta || dashDelta)) { fail(n, 'indentation indicator'); continue; }
      if (plan === 'child' && !isItem && !s.key && s.value?.kind === 'block') { fail(n, 'block'); continue; }

      frames.length = cut;
      if (plan === 'zeroSeq') {
        const f = { type: 'seq', oldCol: c, newCol, zero: true, path: [...top.path, top.lastKey], index: -1 };
        top.pending = false;
        frames.push(f);
        top = f;
      } else if (plan === 'child') {
        const path = top ? [...top.path, top.type === 'map' ? top.lastKey : top.index] : [];
        const owner = top ? [top.pendingOld, top.pendingNew] : [-1, -1];
        if (top) top.pending = false;
        if (isItem || s.key) {
          const f = { type: isItem ? 'seq' : 'map', oldCol: c, newCol, path, index: -1, keys: new Map() };
          frames.push(f);
          top = f;
        } else {
          // A scalar on its own line(s): the value of the key or item above.
          entries.push({ kind: 'scalar', line: n, path, value: s.value, text: t });
          out[n] = { role: 'content', newIndent: newCol, s, t };
          cont = startCont(s.value, owner[0], owner[1] - owner[0], n);
          continue;
        }
      }
      let frame = top;
      for (let k = 0; k < s.dashes.length; k++) {
        frame.index++;
        frame.pending = false;
        entries.push({ kind: 'item', line: n, col: s.dashes[k], path: [...frame.path, frame.index], frame });
        if (k + 1 < s.dashes.length) {
          const f = { type: 'seq', oldCol: s.dashes[k + 1], newCol: dashNew[k + 1], path: [...frame.path, frame.index], index: -1 };
          frames.push(f);
          frame = f;
        }
      }
      if (s.key) {
        if (isItem) {
          const f = { type: 'map', oldCol: s.key.start, newCol: bodyNew, path: [...frame.path, frame.index], index: -1, keys: new Map(), item: n };
          frames.push(f);
          frame = f;
        }
        frame.lastKey = s.key.name;
        frame.pending = false;
        const e = { kind: 'key', line: n, key: s.key, name: s.key.name, path: [...frame.path, s.key.name], frame, value: s.value, text: t, fixed };
        if (!frame.keys.has(s.key.name)) frame.keys.set(s.key.name, e);
        entries.push(e);
        if (s.value.kind === 'empty') Object.assign(frame, { pending: true, pendingOld: s.key.start, pendingNew: bodyNew });
        else cont = startCont(s.value, s.key.start, bodyDelta, n);
      } else if (isItem) {
        const dash = s.dashes.at(-1);
        if (s.empty || s.value.kind === 'empty') Object.assign(frame, { pending: true, pendingOld: dash, pendingNew: dashNew.at(-1) });
        else {
          entries.push({ kind: 'scalar', line: n, path: [...frame.path, frame.index], value: s.value, text: t });
          cont = startCont(s.value, dash, dashDelta, n);
        }
      }
      out[n] = { role: 'content', newIndent: newCol, s, t };
    }
    // A comment line takes the indentation of the line it comments (the next one) when it was at that line's column,
    // else of the open collection at its column; anything else stays where it is.
    for (let n = 0; n < lines.length; n++) {
      const o = out[n];
      if (o?.role !== 'comment') continue;
      let next = n + 1;
      while (next < lines.length && out[next] && out[next].role !== 'content' && out[next].role !== 'doc') next++;
      const nx = out[next]?.role === 'content' ? out[next] : null;
      const frame = o.frames.find(([old]) => old === o.indent);
      o.newIndent = nx && nx.s.indent === o.indent ? nx.newIndent : frame ? frame[1] : o.indent;
    }
    return { out, entries, error, cont };
  }

  // ---------- formatter ----------
  // The rest of a content line (from its first token): dashes as "- ", "key:" with no blank before the colon, one space
  // before the value, the value itself untouched, the blanks before a comment kept, trailing blanks dropped.
  function normalize(t, s) {
    const dashes = '- '.repeat(s.dashes.length);
    if (s.empty) {
      const head = dashes.trimEnd();
      return s.comment >= 0 ? head + t.slice(s.dashes.at(-1) + 1, s.comment) + t.slice(s.comment).trimEnd() : head;
    }
    const v = s.value;
    const head = s.key ? `${dashes}${t.slice(s.body, s.key.end)}:` : dashes;
    const gapBefore = s.key ? ' ' : '';
    if (v.kind === 'quote-open' || v.kind === 'flow-open') return head + gapBefore + t.slice(v.start);
    const body = t.slice(v.start, v.end);
    let line = body ? head + gapBefore + body : head;
    if (v.comment >= 0) line += t.slice(body ? v.end : s.key ? s.key.colon + 1 : s.body, v.comment) + t.slice(v.comment).trimEnd();
    return line;
  }
  function shiftBlock(t, o) {
    if (o.delta === 0) return t;
    if (!t.trim()) {
      if (/[^ ]/.test(t)) return null;
      return t.length <= o.cont.contentIndent ? '' : ' '.repeat(t.length + o.delta);
    }
    const ind = /^ */.exec(t)[0].length;
    return ' '.repeat(ind + o.delta) + t.slice(ind);
  }
  function shiftCont(t, o) {
    if (!t.trim()) return '';
    const lead = /^[ \t]*/.exec(t)[0];
    const body = o.keep ? t.slice(lead.length) : t.slice(lead.length).trimEnd();
    if (o.delta === 0) return lead + body;
    if (lead.includes('\t')) return null;
    return ' '.repeat(Math.max(0, lead.length + o.delta)) + body;
  }
  // -> {text} or {error: {line, why}}.
  function formatYaml(text, unit) {
    const src = text.replace(/\r\n?/g, '\n');
    if (!src.trim()) return { text: '' };
    const endsNL = src.endsWith('\n');
    const lines = (endsNL ? src.slice(0, -1) : src).split('\n');
    const w = walk(lines, { unit });
    if (w.error) return { error: w.error };
    // A quoted scalar or flow collection still open at the end: the file is broken there, not formatted already.
    if (w.cont?.kind === 'quote' || w.cont?.kind === 'flow') return { error: { line: w.cont.line + 1, why: 'unclosed' } };
    const res = [];
    for (let n = 0; n < lines.length; n++) {
      const o = w.out[n];
      const t = lines[n];
      let r;
      switch (o.role) {
        case 'blank': r = ''; break;
        case 'doc': case 'keep': r = t.trimEnd(); break;
        case 'comment': r = ' '.repeat(o.newIndent) + t.trim(); break;
        case 'block': r = shiftBlock(t, o); break;
        case 'cont': r = shiftCont(t, o); break;
        default: r = ' '.repeat(o.newIndent) + normalize(o.t, o.s);
      }
      if (r === null) return { error: { line: n + 1, why: 'tab' } };
      res.push(r);
    }
    // A single final newline, unless the file ends in a block scalar whose value would change: "|+" keeps trailing
    // lines, and "|" without a final newline has none in its value.
    const end = w.cont?.kind === 'block' ? w.cont : null;
    if (end?.chomp === '+') return { text: res.join('\n') + (endsNL ? '\n' : '') };
    const lastIsContent = w.out[lines.length - 1]?.role === 'block' && lines.at(-1).trim();
    while (res.length && !res.at(-1).trim() && (!end || res.at(-1).length <= end.contentIndent)) res.pop();
    if (end && end.chomp === '' && !endsNL && lastIsContent) return { text: res.join('\n') };
    const out = res.length ? `${res.join('\n')}\n` : '';
    // The result must read the same: same keys, items and values at the same paths, and formatting it again changes
    // nothing. Otherwise the file is left alone.
    const outline = (txt) => {
      const ls = txt.replace(/\n$/, '').split('\n');
      const ww = walk(ls, { unit });
      return ww.error ? null : ww.entries.map((e) => `${e.kind}${JSON.stringify(e.path)}=${e.value ? e.text.slice(e.value.start, e.value.end) : ''}`).join('\n');
    };
    const before = outline(src);
    if (before === null || before !== outline(out)) return { error: { line: 1, why: 'check' } };
    return { text: out };
  }

  const refusal = (err) => (err.why === 'tab'
    ? tr('Cannot reformat: line {line} is indented with a tab', { line: err.line })
    : tr('Cannot reformat: the YAML on line {line} cannot be reformatted safely', { line: err.line }));
  monaco.languages.registerDocumentFormattingEditProvider('yaml', {
    displayName: 'YAML',
    provideDocumentFormattingEdits(model) {
      const r = formatYaml(model.getValue(), df.indentOf(model));
      return r.error ? [] : df.wholeEdit(model, r.text);
    },
  });
  df.refusals.set('yaml', (model, unit) => {
    const r = formatYaml(model.getValue(), unit);
    return r.error ? refusal(r.error) : null;
  });

  // ---------- schemas ----------
  const yamlSchemas = []; // {test(path), schema}
  function schemaFor(model) {
    if (model.isDisposed() || model.getLanguageId() !== 'yaml' || model.uri.scheme !== 'file') return null;
    const p = model.uri.path;
    return yamlSchemas.find((s) => s.test(p))?.schema || null;
  }
  const types = (s) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);
  const isObjectish = (s) => types(s).includes('object') || !!s.properties || !!s.patternProperties || (s.additionalProperties !== undefined && !s.anyOf);
  const isArrayish = (s) => types(s).includes('array') || !!s.items;
  const acceptsScalar = (s) => (s.enum ? true : s.type ? types(s).some((x) => ['string', 'number', 'integer', 'boolean', 'null'].includes(x))
    : !(s.properties || s.items || s.additionalProperties !== undefined || s.anyOf));
  // A schema with its anyOf branches, flattened (the outer one first: it has the description).
  const expand = (list) => list.flatMap((s) => (s?.anyOf ? [s, ...expand(s.anyOf)] : s ? [s] : []));
  const allows = (s, key) => (s.properties && Object.hasOwn(s.properties, key))
    || Object.keys(s.patternProperties || {}).some((p) => new RegExp(p).test(key)) || s.additionalProperties !== false;
  // The schemas that describe the node at `path`.
  function resolve(root, path) {
    let cur = expand([root]);
    for (const seg of path) {
      const next = [];
      for (const s of cur) {
        if (typeof seg === 'number') { if (isArrayish(s) && s.items) next.push(s.items); continue; }
        if (!isObjectish(s)) continue;
        if (s.properties && Object.hasOwn(s.properties, seg)) { next.push(s.properties[seg]); continue; }
        const pats = Object.entries(s.patternProperties || {}).filter(([p]) => new RegExp(p).test(seg));
        if (pats.length) next.push(...pats.map(([, v]) => v));
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') next.push(s.additionalProperties);
        else if (s.additionalProperties === undefined || s.additionalProperties === true) next.push({});
      }
      cur = expand(next);
      if (!cur.length) break;
    }
    return cur;
  }
  const descOf = (list) => list.find((s) => s.description)?.description || '';
  // Values offered after "key: ": enum values, examples, true/false.
  function valuesOf(list) {
    const out = new Map();
    for (const s of list) {
      for (const v of s.enum || []) if (!out.has(String(v))) out.set(String(v), { value: v, kind: K.EnumMember });
      for (const v of s.examples || []) if (!out.has(String(v))) out.set(String(v), { value: v, kind: K.Value });
      if (!s.enum && types(s).includes('boolean')) for (const v of [true, false]) if (!out.has(String(v))) out.set(String(v), { value: v, kind: K.Value });
    }
    return [...out.values()];
  }
  // null when `value` is fine (or not checked: only enums and patterns are), else the allowed values.
  function badValue(list, value) {
    const sc = list.filter((s) => !s.anyOf && acceptsScalar(s));
    if (!sc.length || sc.some((s) => !s.enum && !s.pattern)) return null;
    if (sc.some((s) => (s.enum ? s.enum.some((v) => String(v) === value) : new RegExp(s.pattern).test(value)))) return null;
    return [...new Set(sc.flatMap((s) => s.enum || []).map(String))];
  }
  // Words YAML reads as booleans, null or numbers are quoted when completed as strings.
  const needsQuotes = (v) => typeof v === 'string' && (/^(?:y|n|yes|no|true|false|on|off|null|~)$/i.test(v) || /^[-+.]?\d/.test(v) || /^[\s&*!|>'"%@`{}[\],?#-]|: | #|\s$/.test(v));
  const yamlValue = (v) => (needsQuotes(v) ? JSON.stringify(v) : String(v));

  // ---------- completion ----------
  const PROBE = '__pyide_caret__';
  function shapeOf(schema) {
    const all = expand([schema]).filter((s) => !s.anyOf);
    if (!all.length || all.some(acceptsScalar)) return 'scalar';
    return all.some(isObjectish) ? 'object' : 'array';
  }
  const md = (text) => (text ? { value: text } : undefined);
  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [' '],
    provideCompletionItems(model, position, context) {
      const root = schemaFor(model);
      if (!root) return undefined;
      const lines = model.getLinesContent();
      const n = position.lineNumber - 1;
      const line = lines[n];
      const before = line.slice(0, position.column - 1);
      const cm = commentFrom(line, 0);
      if (cm >= 0 && cm < before.length && !/["']/.test(line.slice(0, cm))) return undefined;
      const suggestions = [];
      const seen = new Set();
      const addValues = (list, start, end, prefixOk) => {
        for (const { value, kind } of valuesOf(list)) {
          const label = String(value);
          if (seen.has(`v:${label}`) || !prefixOk) continue;
          seen.add(`v:${label}`);
          suggestions.push({ label, kind, insertText: yamlValue(value), filterText: label, documentation: md(descOf(list)),
            range: new monaco.Range(n + 1, start + 1, n + 1, end + 1), sortText: `1${label}` });
        }
      };
      // A key being typed: indentation, list dashes, then a word.
      const km = /^( *)((?:- +)*)([\w.-]*)$/.exec(before);
      if (km) {
        // A space typed in the indentation is no request for keys; "- " is.
        if (context?.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter && !km[3] && !before.endsWith('- ')) return undefined;
        const wordStart = before.length - km[3].length;
        const wordEnd = before.length + /^[\w.-]*/.exec(line.slice(before.length))[0].length;
        const hasColon = /^\s*:/.test(line.slice(wordEnd));
        const probe = lines.slice();
        probe[n] = `${before.slice(0, wordStart)}${PROBE}:`;
        const e = walk(probe, { lenient: true }).entries.find((x) => x.kind === 'key' && x.line === n);
        if (!e) return undefined;
        const list = resolve(root, e.frame.path);
        const present = new Set([...e.frame.keys.keys()].filter((k) => k !== PROBE));
        const range = new monaco.Range(n + 1, wordStart + 1, n + 1, wordEnd + 1);
        for (const s of list) {
          if (!isObjectish(s) || !s.properties) continue;
          for (const [key, p] of Object.entries(s.properties)) {
            if (present.has(key) || seen.has(key)) continue;
            seen.add(key);
            const shape = shapeOf(p);
            const insertText = hasColon ? key : shape === 'object' ? `${key}:\n\t$0` : shape === 'array' ? `${key}:\n\t- $0` : `${key}: $0`;
            const retrigger = !hasColon && shape === 'scalar' && valuesOf(expand([p])).length;
            suggestions.push({ label: key, kind: K.Property, insertText, insertTextRules: SNIPPET, range, documentation: md(descOf(expand([p]))),
              sortText: `0${key}`, ...(retrigger && { command: { id: 'editor.action.triggerSuggest', title: '' } }) });
          }
        }
        // "- " in a list of values: the values.
        if (km[2] && e.frame.item === n) addValues(list, wordStart, wordEnd, true);
        return { suggestions };
      }
      // A value after "key: ".
      const s = scanLine(line);
      if (s.kind !== 'content' || !s.key || position.column - 1 <= s.key.colon) return undefined;
      const start = s.key.vStart;
      const typed = line.slice(start, position.column - 1);
      if (!/^[\w./@:-]*$/.test(typed)) return undefined;
      const e = walk(lines, { lenient: true }).entries.find((x) => x.kind === 'key' && x.line === n);
      if (!e) return undefined;
      const end = start + /^[\w./@:-]*/.exec(line.slice(start))[0].length;
      addValues(resolve(root, e.path), start, end, true);
      return { suggestions };
    },
  });

  // ---------- hover ----------
  monaco.languages.registerHoverProvider('yaml', {
    provideHover(model, position) {
      const root = schemaFor(model);
      if (!root) return undefined;
      const n = position.lineNumber - 1;
      const col = position.column - 1;
      const e = walk(model.getLinesContent(), { lenient: true }).entries.find((x) => x.kind === 'key' && x.line === n && col >= x.key.start && col <= x.key.end);
      if (!e) return undefined;
      const list = resolve(root, e.path);
      const desc = descOf(list);
      if (!desc) return undefined;
      const values = [...new Set(list.flatMap((s) => s.enum || []).map(String))];
      const dflt = list.find((s) => s.default !== undefined)?.default;
      const parts = [`**${e.name}**`, desc];
      if (values.length) parts.push(tr('Allowed values: {values}', { values: values.map((v) => `\`${v}\``).join(', ') }));
      if (dflt !== undefined) parts.push(tr('Default: {value}', { value: `\`${dflt}\`` }));
      return { range: new monaco.Range(n + 1, e.key.start + 1, n + 1, e.key.end + 1), contents: parts.map((value) => ({ value })) };
    },
  });

  // ---------- validation ----------
  // Light checks: keys a closed mapping does not have, and values outside an enum. Warnings, as PyCharm shows them.
  const EXPR = /\$\{\{/;
  function validate(model) {
    if (model.isDisposed()) return;
    const root = schemaFor(model);
    if (!root) {
      if (marked.delete(model)) monaco.editor.setModelMarkers(model, OWNER, []);
      return;
    }
    const w = walk(model.getLinesContent(), { lenient: true });
    const cache = new Map();
    const at = (path) => {
      const k = JSON.stringify(path);
      if (!cache.has(k)) cache.set(k, resolve(root, path));
      return cache.get(k);
    };
    const markers = [];
    const warn = (line, start, end, message) => markers.push({ severity: monaco.MarkerSeverity.Warning, message,
      startLineNumber: line + 1, startColumn: start + 1, endLineNumber: line + 1, endColumn: end + 1 });
    const checkValue = (e) => {
      const v = e.value;
      if (!v || (v.kind !== 'plain' && v.kind !== 'quoted') || v.props) return;
      const raw = e.text.slice(v.start, v.end);
      const value = v.kind === 'quoted' ? unquote(raw) : raw;
      if (EXPR.test(value)) return;
      const allowed = badValue(at(e.path), value);
      if (allowed) warn(e.line, v.start, v.end, allowed.length
        ? tr('Value "{value}" is not allowed here. Allowed values: {values}', { value, values: allowed.join(', ') })
        : tr('Value "{value}" is not allowed here', { value }));
    };
    for (const e of w.entries) {
      if (e.kind === 'key') {
        if (EXPR.test(e.name) || e.name === '<<' || e.fixed) continue;
        const objs = at(e.frame.path).filter(isObjectish);
        if (objs.length && objs.every((o) => !allows(o, e.name))) warn(e.line, e.key.start, e.key.end, tr('Unknown key "{key}"', { key: e.name }));
        else checkValue(e);
      } else if (e.kind === 'scalar') checkValue(e);
    }
    monaco.editor.setModelMarkers(model, OWNER, markers);
    marked.add(model);
  }
  const marked = new WeakSet();
  const timers = new WeakMap();
  const schedule = (model) => {
    if (model.isDisposed() || (model.getLanguageId() !== 'yaml' && !marked.has(model))) return;
    clearTimeout(timers.get(model));
    timers.set(model, setTimeout(() => validate(model), 250));
  };
  function watch(model) {
    model.onDidChangeContent(() => schedule(model));
    model.onDidChangeLanguage(() => schedule(model));
    model.onWillDispose(() => { clearTimeout(timers.get(model)); monaco.editor.setModelMarkers(model, OWNER, []); });
    schedule(model);
  }
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);

  // test(path): the model's URI path (/c:/project/.github/workflows/ci.yml).
  function addYamlSchema(test, schema) {
    yamlSchemas.push({ test, schema });
    monaco.editor.getModels().forEach(schedule);
  }
  Object.assign(df, { addYamlSchema, yaml: { walk, formatYaml, resolve, scanLine } });
})();
