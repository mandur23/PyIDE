// XML Reformat Code for the data-formats plugin: one element per line, indented by the model's indentation. Text,
// CDATA, comments, processing instructions, the XML declaration and DOCTYPE are kept as written; so are start tags
// (attributes stay on the tag's line, in their order) and self-closing tags. An element with text in it (mixed content)
// or with xml:space="preserve" keeps its whole content as it is. A file that is not well-formed is left alone.
(() => {
  const monaco = ide.monaco;
  const df = ide.dataFormats;
  // Deeper elements are not reformatted: the printer recurses per level, and each level indents every line below it
  // (10,000 levels would print hundreds of MB of indentation).
  const MAX_DEPTH = 1000;

  // -> {nodes} (a tree: {type: element|text|comment|cdata|pi|doctype, raw…}) or {error: {line, why?}}.
  function parse(src) {
    const root = { children: [] };
    const stack = [root];
    const lineAt = (i) => src.slice(0, i).split('\n').length;
    const fail = (i) => ({ error: { line: lineAt(i) } });
    const add = (node) => stack.at(-1).children.push(node);
    let i = 0;
    while (i < src.length) {
      if (src[i] !== '<') {
        const e = src.indexOf('<', i);
        const end = e < 0 ? src.length : e;
        add({ type: 'text', raw: src.slice(i, end) });
        i = end;
        continue;
      }
      const special = [['<!--', '-->', 'comment'], ['<![CDATA[', ']]>', 'cdata'], ['<?', '?>', 'pi']].find(([open]) => src.startsWith(open, i));
      if (special) {
        const e = src.indexOf(special[1], i + special[0].length);
        if (e < 0) return fail(i);
        add({ type: special[2], raw: src.slice(i, e + special[1].length) });
        i = e + special[1].length;
        continue;
      }
      if (src.startsWith('<!', i)) { // DOCTYPE (with an internal subset in [ ]) and other declarations
        let depth = 0;
        let quote = null;
        let k = i + 2;
        for (; k < src.length; k++) {
          const c = src[k];
          if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
          else if (c === '[') depth++;
          else if (c === ']') depth--;
          else if (c === '>' && depth <= 0) break;
        }
        if (k >= src.length) return fail(i);
        add({ type: 'doctype', raw: src.slice(i, k + 1) });
        i = k + 1;
        continue;
      }
      if (src.startsWith('</', i)) {
        const m = /^<\/([^\s>]+)\s*>/.exec(src.slice(i));
        const open = stack.at(-1);
        if (!m || stack.length < 2 || open.name !== m[1]) return fail(i);
        open.end = i;
        open.close = m[0];
        stack.pop();
        i += m[0].length;
        continue;
      }
      // A start tag: up to the > outside quoted attribute values.
      const name = /^<([^\s/>!?]+)/.exec(src.slice(i))?.[1];
      if (!name) return fail(i);
      let quote = null;
      let k = i + 1 + name.length;
      for (; k < src.length; k++) {
        const c = src[k];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '<') return fail(k);
        else if (c === '>') break;
      }
      if (k >= src.length) return fail(i);
      const raw = src.slice(i, k + 1);
      const selfClosing = /\/\s*>$/.test(raw);
      const el = { type: 'element', name, open: raw, selfClosing, children: [], start: k + 1,
        preserve: /\sxml:space\s*=\s*(["'])preserve\1/.test(raw) };
      add(el);
      if (!selfClosing && stack.length > MAX_DEPTH) return { error: { line: lineAt(i), why: 'depth' } };
      if (!selfClosing) stack.push(el);
      i = k + 1;
    }
    if (stack.length > 1) return fail(stack.at(-1).start - 1);
    return { nodes: root.children };
  }

  const blank = (n) => n.type === 'text' && !n.raw.trim();
  // -> {text} or {error: {line}}.
  function formatXml(text, unit) {
    const src = text.replace(/\r\n?/g, '\n');
    if (!src.trim()) return { text: '' };
    const r = parse(src);
    if (r.error) return r;
    if (r.nodes.some((n) => n.type === 'text' && n.raw.trim())) return { error: { line: 1 } };
    const out = [];
    // Children one per line; a blank line between two of them stays (one at most).
    const list = (nodes, depth) => {
      let gap = false;
      for (const n of nodes) {
        if (blank(n)) { gap = (n.raw.match(/\n/g) || []).length > 1; continue; }
        if (gap && out.length) out.push('');
        gap = false;
        node(n, depth);
      }
    };
    const node = (n, depth) => {
      const ind = unit.repeat(depth);
      if (n.type !== 'element') { out.push(ind + n.raw); return; }
      if (n.selfClosing) { out.push(ind + n.open); return; }
      const content = src.slice(n.start, n.end);
      const kids = n.children.filter((c) => !blank(c));
      // Text, CDATA or xml:space="preserve": the content as it is. Only blanks: an empty element.
      if (n.preserve || kids.some((c) => c.type === 'text' || c.type === 'cdata')) out.push(ind + n.open + content + n.close);
      else if (!kids.length) out.push(ind + n.open + (content.includes('\n') ? '' : content) + n.close);
      else {
        out.push(ind + n.open);
        list(n.children, depth + 1);
        out.push(ind + n.close);
      }
    };
    list(r.nodes, 0);
    return { text: `${out.join('\n')}\n` };
  }

  const unitOf = (model, options) => (options?.insertSpaces === false || !model.getOptions().insertSpaces ? '\t' : ' '.repeat(df.indentOf(model)));
  monaco.languages.registerDocumentFormattingEditProvider('xml', {
    displayName: 'XML',
    provideDocumentFormattingEdits(model, options) {
      const r = formatXml(model.getValue(), unitOf(model, options));
      return r.error ? [] : df.wholeEdit(model, r.text);
    },
  });
  df.refusals.set('xml', (model) => {
    const r = formatXml(model.getValue(), unitOf(model));
    if (!r.error) return null;
    return r.error.why === 'depth' ? tr('Cannot reformat: the XML is nested too deeply (line {line})', { line: r.error.line })
      : tr('Cannot reformat: the XML is not well-formed (line {line})', { line: r.error.line });
  });
  df.xml = { formatXml };
})();
