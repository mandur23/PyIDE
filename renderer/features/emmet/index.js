// Emmet, as in PyCharm and VS Code: an abbreviation right before the caret expands with Tab (or from the completion
// list, where it shows a preview) into a Monaco snippet with tab stops in empty attribute values and element bodies.
// HTML: elements, #id, .class, [attr=value], >, +, ^, *N, $ numbering ($$, $@3, $@-), {text}, (groups), implicit tags
// (li in ul, tr in table, td in tr, option in select, span in inline elements, div elsewhere), `!` / html:5, aliases
// such as a, img, input:text, link:css, script:src, meta:vp, and lorem / loremN. In HTML text content a word expands
// only when it is a known element or alias or the abbreviation has operators, as in PyCharm (VS Code expands any
// word); never in a tag, an attribute value, a comment or script content. Content of <style> is CSS. In .jsx and .tsx
// files markup expands only where JSX is expected (after `return (`, `=> (`, `&& (`, or after a JSX tag), with
// className and self-closing void elements. CSS, SCSS and Less: property abbreviations (m10, p10-20, w100p, d:f,
// c#f, fw:b, m10! for !important) inside a rule block, not in a selector, string or comment.
// Tab is left to the completion list while it shows, to visible ghost text and to an active snippet.
// Settings › Editor › Smart Keys › Emmet turns it off.
(() => {
  const monaco = ide.monaco;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const ENABLED = 'editor.emmet';
  const DEFAULTS = { [ENABLED]: true };
  const enabled = () => ide.settings.get(ENABLED, true) !== false;

  // ---------- HTML vocabulary ----------
  const TAGS = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col ' +
    'colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 ' +
    'head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ' +
    'ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source ' +
    'span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr').split(' '));
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const INLINE = new Set(('a abbr acronym b bdi bdo big br button cite code del dfn em font i iframe img input ins kbd label map mark ' +
    'object q s samp select small span strike strong sub sup textarea time tt u var wbr').split(' '));
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  // Implicit element names by parent element.
  const IMPLICIT = { ul: 'li', ol: 'li', menu: 'li', table: 'tr', tbody: 'tr', thead: 'tr', tfoot: 'tr', tr: 'td', select: 'option',
    optgroup: 'option', datalist: 'option', colgroup: 'col', audio: 'source', video: 'source', picture: 'source' };
  const input = (type, extra = [['name', ''], ['id', '']]) => ({ name: 'input', attrs: [['type', type], ...extra] });
  const ALIASES = {
    a: { name: 'a', attrs: [['href', '']] },
    'a:link': { name: 'a', attrs: [['href', 'http://']] },
    'a:mail': { name: 'a', attrs: [['href', 'mailto:']] },
    'a:blank': { name: 'a', attrs: [['href', 'http://'], ['target', '_blank'], ['rel', 'noopener noreferrer']] },
    img: { name: 'img', attrs: [['src', ''], ['alt', '']] },
    input: { name: 'input', attrs: [['type', 'text']] },
    'input:text': input('text'), 'input:t': input('text'), 'input:checkbox': input('checkbox'), 'input:c': input('checkbox'),
    'input:radio': input('radio'), 'input:r': input('radio'), 'input:password': input('password'), 'input:p': input('password'),
    'input:email': input('email'), 'input:number': input('number'), 'input:file': input('file'), 'input:f': input('file'),
    'input:hidden': input('hidden', [['name', ''], ['value', '']]), 'input:h': input('hidden', [['name', ''], ['value', '']]),
    'input:submit': input('submit', [['value', '']]), 'input:s': input('submit', [['value', '']]),
    'input:button': input('button', [['value', '']]), 'input:b': input('button', [['value', '']]),
    link: { name: 'link', attrs: [['rel', 'stylesheet'], ['href', '']] },
    'link:css': { name: 'link', attrs: [['rel', 'stylesheet'], ['href', 'style.css']] },
    'link:favicon': { name: 'link', attrs: [['rel', 'shortcut icon'], ['type', 'image/x-icon'], ['href', 'favicon.ico']] },
    'script:src': { name: 'script', attrs: [['src', '']] },
    'meta:vp': { name: 'meta', attrs: [['name', 'viewport'], ['content', 'width=device-width, initial-scale=1.0']] },
    'meta:utf': { name: 'meta', attrs: [['charset', 'UTF-8']] },
    form: { name: 'form', attrs: [['action', '']] },
    'form:get': { name: 'form', attrs: [['action', ''], ['method', 'get']] },
    'form:post': { name: 'form', attrs: [['action', ''], ['method', 'post']] },
    label: { name: 'label', attrs: [['for', '']] },
    select: { name: 'select', attrs: [['name', ''], ['id', '']] },
    textarea: { name: 'textarea', attrs: [['name', ''], ['id', ''], ['cols', '30'], ['rows', '10']] },
    iframe: { name: 'iframe', attrs: [['src', '']] },
    'btn': { name: 'button' }, 'btn:s': { name: 'button', attrs: [['type', 'submit']] }, 'button:s': { name: 'button', attrs: [['type', 'submit']] },
    bq: { name: 'blockquote' }, fig: { name: 'figure' }, figc: { name: 'figcaption' }, sect: { name: 'section' }, art: { name: 'article' },
    hdr: { name: 'header' }, ftr: { name: 'footer' }, adr: { name: 'address' }, str: { name: 'strong' }, cap: { name: 'caption' },
    colg: { name: 'colgroup' }, fst: { name: 'fieldset' }, leg: { name: 'legend' }, opt: { name: 'option' }, optg: { name: 'optgroup' },
    tarea: { name: 'textarea', attrs: [['name', ''], ['id', ''], ['cols', '30'], ['rows', '10']] }, det: { name: 'details' },
    sum: { name: 'summary' }, pic: { name: 'picture' }, prog: { name: 'progress' }, dlg: { name: 'dialog' }, mn: { name: 'main' },
    tem: { name: 'template' }, datal: { name: 'datalist' },
  };
  const DOC = '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '\t<title>${1:Document}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>';
  const LOREM_RE = /^(?:lorem|lipsum)(\d*)$/i;
  const LOREM_START = 'lorem ipsum dolor sit amet consectetur adipisicing elit'.split(' ');
  const LOREM_WORDS = ('sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ' +
    'ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla ' +
    'pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum').split(' ');

  // `n` words of placeholder text in sentences, the first one starting "Lorem ipsum dolor sit amet". Deterministic.
  function lorem(n, seed = 0) {
    let s = (seed * 7919 + 104729) % 233280;
    const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const words = [];
    for (let k = 0; k < n; k++) words.push(k < LOREM_START.length && seed === 0 ? LOREM_START[k] : LOREM_WORDS[Math.floor(rnd() * LOREM_WORDS.length)]);
    const sentences = [];
    for (let k = 0; k < words.length;) {
      let len = k === 0 && seed === 0 ? LOREM_START.length : 5 + Math.floor(rnd() * 8);
      if (words.length - (k + len) < 3) len = words.length - k;
      const w = words.slice(k, k + len);
      if (w.length > 7) w[3 + Math.floor(rnd() * (w.length - 5))] += ',';
      w[0] = w[0][0].toUpperCase() + w[0].slice(1);
      sentences.push(w.join(' ') + '.');
      k += len;
    }
    return sentences.join(' ');
  }

  // ---------- HTML abbreviation parser ----------
  // A name, id, class or attribute token: word characters, `-`, `:` and $ numbering ($, $$, $@3, $@-, $@-3).
  const TOKEN = /(?:[\w:-]|\$+(?:@-?\d*)?|\\\$)+/y;
  function parseHtml(abbr) {
    let i = 0;
    const fail = () => { throw new SyntaxError('emmet'); };
    const token = () => {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(abbr);
      if (!m) return '';
      i = TOKEN.lastIndex;
      return m[0];
    };
    const repeat = () => {
      if (abbr[i] !== '*') return 1;
      const m = /^\d+/.exec(abbr.slice(i + 1));
      if (!m) fail();
      i += 1 + m[0].length;
      return Math.max(1, Math.min(+m[0], 200));
    };
    const text = () => {
      let depth = 1;
      let out = '';
      for (; i < abbr.length; i++) {
        const c = abbr[i];
        if (c === '\\' && i + 1 < abbr.length && abbr[i + 1] !== '$') { out += abbr[++i]; continue; }
        if (c === '{') depth++;
        else if (c === '}' && !--depth) { i++; return out; }
        out += c;
      }
      return fail();
    };
    const attrs = (node) => {
      for (;;) {
        while (abbr[i] === ' ') i++;
        if (abbr[i] === ']') { i++; return; }
        const m = /^[^\s="'\]]+/.exec(abbr.slice(i));
        if (!m) fail();
        i += m[0].length;
        let value = '';
        if (abbr[i] === '=') {
          i++;
          const q = abbr[i];
          if (q === '"' || q === "'") {
            const end = abbr.indexOf(q, i + 1);
            if (end < 0) fail();
            value = abbr.slice(i + 1, end);
            i = end + 1;
          } else {
            const v = /^[^\s\]]*/.exec(abbr.slice(i))[0];
            value = v;
            i += v.length;
          }
        }
        node.attrs.push([m[0], value]);
        if (i >= abbr.length) fail();
      }
    };
    const item = () => {
      if (abbr[i] === '(') {
        i++;
        const children = seq(')');
        if (abbr[i] !== ')') fail();
        i++;
        return { group: true, children, repeat: repeat() };
      }
      const node = { name: '', id: null, classes: [], attrs: [], text: null, children: [], repeat: 1 };
      if (/[A-Za-z$]/.test(abbr[i] || '')) node.name = token();
      let any = !!node.name;
      for (;;) {
        const c = abbr[i];
        if (c === '#') { i++; node.id = token() || fail(); }
        else if (c === '.') { i++; node.classes.push(token() || fail()); }
        else if (c === '[') { i++; attrs(node); }
        else if (c === '{') { i++; node.text = (node.text || '') + text(); }
        else break;
        any = true;
      }
      if (!any) fail();
      node.repeat = repeat();
      return node;
    };
    // Elements joined by > (child), + (sibling) and ^ (climb one level per ^), up to `end` or the end of the text.
    function seq(end) {
      const root = { children: [] };
      const stack = [root];
      for (;;) {
        const node = item();
        stack.at(-1).children.push(node);
        const c = abbr[i];
        if (c === undefined || c === end) break;
        if (c === '>') { i++; stack.push(node); }
        else if (c === '+') i++;
        else if (c === '^') { while (abbr[i] === '^') { i++; if (stack.length > 1) stack.pop(); } }
        else fail();
      }
      return root.children;
    }
    const tree = seq(undefined);
    if (i !== abbr.length) fail();
    return tree;
  }

  // $ numbering in a name, id, class, attribute value or text, by the nearest repeated element or group (num).
  function numbered(s, num) {
    if (!s || !s.includes('$')) return s;
    const index = num ? num.index : 0;
    const count = num ? num.count : 1;
    return s.replace(/\\\$|(\$+)(?:@(-)?(\d+)?)?/g, (m, dollars, rev, start) => {
      if (!dollars) return '$';
      const base = start ? +start : 1;
      return String(rev ? base + count - 1 - index : base + index).padStart(dollars.length, '0');
    });
  }

  // Parsed nodes -> [{name, attrs: [[k, v]], children} | {text}], with repeats, numbering, aliases and implicit names.
  function resolve(nodes, parent, num, st) {
    const out = [];
    for (const n of nodes) {
      for (let k = 0; k < n.repeat; k++) {
        const cur = n.repeat > 1 ? { index: k, count: n.repeat } : num;
        if (++st.count > 1000) throw new RangeError('emmet');
        if (n.group) { out.push(...resolve(n.children, parent, cur, st)); continue; }
        const name = numbered(n.name, cur);
        const plain = !n.id && !n.classes.length && !n.attrs.length;
        const lm = plain && n.text == null && LOREM_RE.exec(name);
        if (lm) {
          out.push({ text: lorem(lm[1] ? Math.min(+lm[1], 1000) : 30, st.lorem++) });
          out.push(...resolve(n.children, parent, cur, st));
          continue;
        }
        if (!name && plain) {
          out.push({ text: numbered(n.text, cur) });
          out.push(...resolve(n.children, parent, cur, st));
          continue;
        }
        const alias = ALIASES[name.toLowerCase()];
        const tag = alias ? alias.name : name || IMPLICIT[parent] || (INLINE.has(parent) ? 'span' : 'div');
        const attrs = (alias?.attrs || []).map(([a, v]) => [a, v]);
        const set = (a, v) => {
          const at = attrs.find((x) => x[0] === a);
          if (at) at[1] = a === 'class' && at[1] ? `${at[1]} ${v}` : v; else attrs.push([a, v]);
        };
        if (n.id != null) set('id', numbered(n.id, cur));
        if (n.classes.length) set('class', n.classes.map((c) => numbered(c, cur)).join(' '));
        for (const [a, v] of n.attrs) set(numbered(a, cur), numbered(v, cur));
        const lower = tag.toLowerCase();
        const children = n.text != null ? [{ text: numbered(n.text, cur) }] : [];
        children.push(...resolve(n.children, lower, cur, st));
        out.push({ name: tag, attrs, children });
      }
    }
    return out;
  }

  const esc = (s) => s.replace(/[\\$}]/g, '\\$&');
  const isInline = (item) => item.text != null || INLINE.has(item.name.toLowerCase());
  // Few inline items stay on one line; block elements and three or more inline elements get a line each.
  const oneLine = (items) => items.every(isInline) && items.filter((x) => x.text == null).length < 3;
  const JSX_ATTR = { class: 'className', for: 'htmlFor' };
  function render(items, ctx) {
    const parts = items.map((x) => (x.text != null ? esc(x.text) : renderElement(x, ctx)));
    return parts.join(oneLine(items) ? '' : '\n');
  }
  function renderElement(el, ctx) {
    const attrs = el.attrs.map(([a, v]) => ` ${ctx.jsx ? JSX_ATTR[a] || a : a}="${v === '' ? `\${${++ctx.field}}` : esc(v)}"`).join('');
    const open = `<${el.name}${attrs}`;
    if (VOID.has(el.name.toLowerCase())) return open + (ctx.jsx ? ' />' : '>');
    if (!el.children.length) return `${open}>\${${++ctx.field}}</${el.name}>`;
    const inner = render(el.children, ctx);
    if (oneLine(el.children)) return `${open}>${inner}</${el.name}>`;
    return `${open}>\n${inner.split('\n').map((l) => `\t${l}`).join('\n')}\n</${el.name}>`;
  }

  // The parsed tree, or null when `abbr` is not a valid abbreviation.
  function parse(abbr) {
    try { return parseHtml(abbr); } catch { return null; }
  }
  // An abbreviation as a markup snippet, or null. jsx: className, htmlFor and <br />; parent: the element it goes in.
  function expandMarkup(abbr, { jsx = false, parent = '' } = {}) {
    if (abbr === '!' || abbr === 'html:5') return jsx ? null : DOC;
    const tree = parse(abbr);
    if (!tree) return null;
    try {
      const items = resolve(tree, String(parent).toLowerCase(), null, { count: 0, lorem: 0 });
      if (!items.length) return null;
      return render(items, { jsx, field: 0 });
    } catch { return null; }
  }

  // ---------- CSS ----------
  const PROPS = {
    m: 'margin', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left',
    p: 'padding', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
    w: 'width', h: 'height', maw: 'max-width', mah: 'max-height', miw: 'min-width', mih: 'min-height',
    t: 'top', r: 'right', b: 'bottom', l: 'left', z: 'z-index', d: 'display', pos: 'position', fl: 'float', cl: 'clear',
    v: 'visibility', ov: 'overflow', ovx: 'overflow-x', ovy: 'overflow-y', c: 'color', op: 'opacity', cur: 'cursor',
    bg: 'background', bgc: 'background-color', bgi: 'background-image', bgr: 'background-repeat', bgs: 'background-size', bgp: 'background-position',
    fz: 'font-size', fw: 'font-weight', fs: 'font-style', ff: 'font-family', lh: 'line-height', ls: 'letter-spacing',
    ta: 'text-align', td: 'text-decoration', tt: 'text-transform', ti: 'text-indent', va: 'vertical-align', ws: 'white-space', wb: 'word-break',
    bd: 'border', bdt: 'border-top', bdr: 'border-right', bdb: 'border-bottom', bdl: 'border-left', bdc: 'border-color', bdw: 'border-width',
    bds: 'border-style', bdrs: 'border-radius', bxsh: 'box-shadow', bxz: 'box-sizing', trs: 'transition', trf: 'transform', anim: 'animation',
    ol: 'outline', lis: 'list-style', ct: 'content', fx: 'flex', fxd: 'flex-direction', fd: 'flex-direction', fxw: 'flex-wrap',
    fxg: 'flex-grow', fxs: 'flex-shrink', fxb: 'flex-basis', jc: 'justify-content', ji: 'justify-items', ai: 'align-items',
    ac: 'align-content', as: 'align-self', ord: 'order', gap: 'gap', rg: 'row-gap', cg: 'column-gap',
    gtc: 'grid-template-columns', gtr: 'grid-template-rows', gta: 'grid-template-areas', gc: 'grid-column', gr: 'grid-row', ga: 'grid-area',
    us: 'user-select', pe: 'pointer-events', obf: 'object-fit', ap: 'appearance',
  };
  const ALIGN = { c: 'center', s: 'start', e: 'end', fs: 'flex-start', fe: 'flex-end', b: 'baseline', st: 'stretch' };
  const OVERFLOW = { h: 'hidden', a: 'auto', s: 'scroll', v: 'visible' };
  const KEYWORDS = {
    display: { b: 'block', n: 'none', f: 'flex', g: 'grid', i: 'inline', ib: 'inline-block', if: 'inline-flex', ig: 'inline-grid', t: 'table', tc: 'table-cell', c: 'contents', li: 'list-item' },
    position: { a: 'absolute', r: 'relative', f: 'fixed', s: 'static', st: 'sticky' },
    float: { l: 'left', r: 'right', n: 'none' }, clear: { b: 'both', l: 'left', r: 'right', n: 'none' },
    visibility: { v: 'visible', h: 'hidden', c: 'collapse' },
    overflow: OVERFLOW, 'overflow-x': OVERFLOW, 'overflow-y': OVERFLOW,
    'font-weight': { b: 'bold', n: 'normal', l: 'lighter', br: 'bolder' }, 'font-style': { i: 'italic', n: 'normal', o: 'oblique' },
    'text-align': { c: 'center', l: 'left', r: 'right', j: 'justify', s: 'start', e: 'end' },
    'text-decoration': { n: 'none', u: 'underline', o: 'overline', l: 'line-through' },
    'text-transform': { u: 'uppercase', l: 'lowercase', c: 'capitalize', n: 'none' },
    'vertical-align': { t: 'top', m: 'middle', b: 'bottom', bl: 'baseline' },
    'white-space': { n: 'normal', nw: 'nowrap', p: 'pre', pw: 'pre-wrap', pl: 'pre-line' },
    'word-break': { ba: 'break-all', ka: 'keep-all', n: 'normal' },
    'justify-content': { c: 'center', s: 'start', e: 'end', fs: 'flex-start', fe: 'flex-end', sb: 'space-between', sa: 'space-around', se: 'space-evenly' },
    'align-items': ALIGN, 'align-content': { ...ALIGN, sb: 'space-between', sa: 'space-around' }, 'align-self': { ...ALIGN, a: 'auto' }, 'justify-items': ALIGN,
    'flex-direction': { r: 'row', c: 'column', rr: 'row-reverse', cr: 'column-reverse' }, 'flex-wrap': { w: 'wrap', nw: 'nowrap', wr: 'wrap-reverse' },
    'box-sizing': { bb: 'border-box', cb: 'content-box' },
    cursor: { p: 'pointer', d: 'default', a: 'auto', t: 'text', m: 'move', na: 'not-allowed', h: 'help', w: 'wait', g: 'grab' },
    'list-style': { n: 'none' }, 'pointer-events': { n: 'none', a: 'auto' }, 'user-select': { n: 'none', a: 'auto', t: 'text' },
    'object-fit': { c: 'cover', ct: 'contain', f: 'fill', n: 'none' }, 'background-repeat': { n: 'no-repeat', x: 'repeat-x', y: 'repeat-y' },
    'background-size': { cv: 'cover', ct: 'contain' }, border: { n: 'none' }, outline: { n: 'none' }, background: { n: 'none' },
    'border-style': { s: 'solid', d: 'dashed', dt: 'dotted', n: 'none' }, appearance: { n: 'none' },
  };
  // What a property abbreviation alone gives (otherwise `name: |;`).
  const BARE = {
    display: '${1:block}', position: '${1:relative}', border: '${1:1px} ${2:solid} ${3:#000}', transition: '${1:all} ${2:0.3s} ${3:ease}',
    'box-shadow': '${1:0} ${2:0} ${3:0} ${4:#000}', 'background-image': 'url($1)', content: '"$1"', 'font-weight': '${1:bold}',
    'text-align': '${1:left}', 'box-sizing': '${1:border-box}', cursor: '${1:pointer}', 'background-color': '${1:#fff}', color: '${1:#000}',
  };
  const UNITLESS = new Set(['z-index', 'opacity', 'font-weight', 'flex', 'flex-grow', 'flex-shrink', 'order']);
  const UNITS = { p: '%', e: 'em', r: 'rem', x: 'ex' };
  const KNOWN_UNITS = new Set(['px', 'em', 'rem', 'ex', 'ch', '%', 'vh', 'vw', 'vmin', 'vmax', 'pt', 'pc', 'cm', 'mm', 'in', 'fr', 's', 'ms', 'deg', 'rad', 'turn', 'dvh', 'dvw', 'svh', 'lvh']);
  const FULL = new Map(Object.values(PROPS).map((p) => [p, p]));

  // Values after a property abbreviation: numbers with units (10, 1.5, 100p, 2e, 10px), a (auto) and #hex colours,
  // separated by `-` (a second `-` makes the next number negative).
  function cssValues(prop, s) {
    const out = [];
    for (let i = 0; i < s.length;) {
      if (out.length) { if (s[i] !== '-') return null; i++; }
      const rest = s.slice(i);
      let m;
      if ((m = /^#([0-9a-f]{1,6})(?![\w])/i.exec(rest))) {
        const h = m[1];
        out.push(`#${h.length === 1 ? h.repeat(3) : h.length === 2 ? h.repeat(3) : h}`);
      } else if ((m = /^(-?)(\d*\.\d+|\d+)([a-z%]*)/i.exec(rest))) {
        const [, sign, num, u] = m;
        const float = num.includes('.');
        let unit = UNITS[u.toLowerCase()] ?? u.toLowerCase();
        if (u && !KNOWN_UNITS.has(unit)) return null;
        if (!u) unit = UNITLESS.has(prop) || (prop === 'line-height' && float) || +num === 0 ? '' : float ? 'em' : 'px';
        out.push(`${sign}${num}${unit}`);
      } else if ((m = /^a(?![a-z])/i.exec(rest))) out.push('auto');
      else return null;
      i += m[0].length;
    }
    return out.length ? out.join(' ') : null;
  }
  // A CSS property abbreviation as a snippet (`margin: 10px;`), or null.
  function expandCss(abbr) {
    let a = abbr;
    let important = false;
    if (a.endsWith('!')) { important = true; a = a.slice(0, -1); }
    let prop;
    let value;
    const colon = a.indexOf(':');
    if (colon > 0) {
      prop = PROPS[a.slice(0, colon)] || FULL.get(a.slice(0, colon));
      const v = a.slice(colon + 1);
      if (!prop || !v) return null;
      value = KEYWORDS[prop]?.[v] ?? (/^[a-z][a-z-]*$/i.test(v) ? v : cssValues(prop, v));
      if (value == null) return null;
      value = esc(value);
    } else {
      const m = /^([a-z]+)(.*)$/i.exec(a);
      if (!m) return null;
      prop = PROPS[m[1]] || FULL.get(m[1]);
      if (!prop) return null;
      if (!m[2]) value = BARE[prop] || '$1';
      else {
        if (!/^[-.\d#]/.test(m[2])) return null;
        value = cssValues(prop, m[2]);
        if (value == null) return null;
      }
    }
    return `${prop}: ${value}${important ? ' !important' : ''};`;
  }

  // ---------- where an abbreviation may expand ----------
  const NAME = /[A-Za-z_][^\s/>]*/y;
  // HTML from the start to offset `end`: {state: text | tag | value | comment | markup | raw, open, raw?, rawStart?}.
  function scanHtml(text, end) {
    const open = [];
    let i = 0;
    while (i < end) {
      const lt = text.indexOf('<', i);
      if (lt < 0 || lt >= end) break;
      i = lt + 1;
      if (text.startsWith('!--', i)) {
        const close = text.indexOf('-->', i + 3);
        if (close < 0 || close + 3 > end) return { state: 'comment', open };
        i = close + 3;
        continue;
      }
      if (text[i] === '!' || text[i] === '?') {
        const close = text.indexOf('>', i);
        if (close < 0 || close + 1 > end) return { state: 'markup', open };
        i = close + 1;
        continue;
      }
      const closing = text[i] === '/';
      NAME.lastIndex = i + (closing ? 1 : 0);
      const m = NAME.exec(text);
      if (!m) continue;
      const name = m[0];
      let quote = null;
      let gt = -1;
      for (i = NAME.lastIndex; i < end; i++) {
        const c = text[i];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') { gt = i; break; }
      }
      if (gt < 0) return { state: quote ? 'value' : 'tag', open };
      i = gt + 1;
      const lower = name.toLowerCase();
      if (closing) {
        const k = open.findLastIndex((n) => n.toLowerCase() === lower);
        if (k >= 0) open.length = k;
      } else if (text[gt - 1] !== '/' && !VOID.has(lower)) {
        if (RAW.has(lower)) {
          const endTag = new RegExp(`</${lower}(?=[\\s/>])`, 'gi');
          endTag.lastIndex = i;
          const e = endTag.exec(text);
          if (!e || e.index >= end) return { state: 'raw', open: [...open, name], raw: lower, rawStart: i };
          i = e.index;
          continue;
        }
        open.push(name);
      }
    }
    return { state: 'text', open };
  }

  // scanHtml of a model up to `offset`, kept for the model's version: Tab's context key and the completion list ask
  // for the same position after each keystroke.
  const scans = new WeakMap(); // model -> {version, offset, at}
  function scanAt(model, offset) {
    const version = model.getVersionId();
    let s = scans.get(model);
    if (s?.version !== version || s.offset !== offset) scans.set(model, (s = { version, offset, at: scanHtml(model.getValue(), offset) }));
    return s.at;
  }

  // True when a declaration may start at the end of `text` (CSS from the start of the file or <style>): inside a rule
  // block (not at the top level or directly in @media and the like), after `{`, `;` or `}`, outside strings and
  // comments. lineComments: SCSS and Less `//` comments.
  function cssDeclarationAt(text, lineComments) {
    const stack = [];
    let stmt = 0;
    const blank = (i) => !text.slice(stmt, i).trim();
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '*') {
        const e = text.indexOf('*/', i + 2);
        if (e < 0) return false;
        if (blank(i)) stmt = e + 2;
        i = e + 1;
      } else if (lineComments && c === '/' && text[i + 1] === '/' && (i === 0 || /[\s;{}]/.test(text[i - 1]))) {
        const e = text.indexOf('\n', i);
        if (e < 0) return false;
        if (blank(i)) stmt = e + 1;
        i = e;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length) return false;
        i = j;
      } else if (c === '#' && text[i + 1] === '{') {
        const e = text.indexOf('}', i);
        if (e < 0) return false;
        i = e;
      } else if (c === '{') {
        stack.push(/^@(media|supports|layer|container|document|scope|starting-style)\b/i.test(text.slice(stmt, i).trim()) ? 'group' : 'rule');
        stmt = i + 1;
      } else if (c === '}') { stack.pop(); stmt = i + 1; }
      else if (c === ';') stmt = i + 1;
    }
    return stack.at(-1) === 'rule' && blank(text.length);
  }

  // The abbreviation that ends at `col` of `line`, from `bound` on: balanced [..] and {..} may hold any character.
  function extractMarkup(line, col, bound = 0) {
    let i = col;
    let brace = 0;
    let bracket = 0;
    while (i > bound) {
      const c = line[i - 1];
      if (c === '}' && !bracket) brace++;
      else if (c === '{' && !bracket) { if (!brace) break; brace--; }
      else if (c === ']' && !brace) bracket++;
      else if (c === '[' && !brace) { if (!bracket) break; bracket--; }
      else if (!brace && !bracket && !/[\w#.:$@!*+^>()\-]/.test(c)) break;
      i--;
    }
    if (brace || bracket) return null;
    // A `(` before the abbreviation that it does not close (`return (ul>li`) is not part of it.
    // Counted once and updated per `(` dropped (counting again each time took seconds on a line of 50k parentheses).
    let start = i;
    let opens = 0;
    let closes = 0;
    for (let k = i; k < col; k++) { if (line[k] === '(') opens++; else if (line[k] === ')') closes++; }
    while (line[start] === '(' && opens > closes) { start++; opens--; }
    const abbr = line.slice(start, col);
    return abbr ? { abbr, start } : null;
  }
  function extractCss(line, col) {
    let i = col;
    while (i > 0 && /[\w#.:!%-]/.test(line[i - 1])) i--;
    const abbr = line.slice(i, col);
    return abbr ? { abbr, start: i } : null;
  }

  const firstName = (tree) => { let n = tree[0]; while (n?.group) n = n.children[0]; return n?.name || ''; };
  const STRUCTURE = /[>+^*[{(]/;
  // HTML text content: expand known elements, aliases and lorem, abbreviations that start with #id / .class, and any
  // with operators (as PyCharm does; a plain word such as "hello" stays text).
  function htmlAccepts(abbr, tree) {
    if (abbr === '!' || abbr === 'html:5') return true;
    const name = firstName(tree).toLowerCase();
    return !name || TAGS.has(name) || !!ALIASES[name] || LOREM_RE.test(name) || STRUCTURE.test(abbr);
  }
  // JSX: a lower-case HTML element, an implicit one (.card), or a component name with operators.
  function jsxAccepts(abbr, tree) {
    const name = firstName(tree);
    if (!name) return true;
    if (TAGS.has(name) || ALIASES[name]) return true;
    return /^[A-Z]/.test(name) && /[>+^*.#[{(]/.test(abbr);
  }
  // Where JSX is expected: after `return (`, `=> (`, `? (`, `: (`, `&& (` or `|| (`, or after a JSX tag.
  const JSX_OPEN = /(?:\breturn|=>|[?:]|&&|\|\|)\s*\($/;
  const JSX_TAG = /(?:^|[^\w$.\])])<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>$/;
  function jsxContext(model, lineNumber, before) {
    let ctx = before.trimEnd();
    for (let n = lineNumber - 1; !ctx && n >= 1 && n >= lineNumber - 3; n--) ctx = model.getLineContent(n).trimEnd();
    return !!ctx && (JSX_OPEN.test(ctx) || JSX_TAG.test(ctx));
  }
  const tokenTypeAt = (model, lineNumber, column) => {
    try {
      const tokens = model.tokenization.getLineTokens(lineNumber);
      return tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(column - 1));
    } catch { return 0; }
  };

  const CSS_LANGS = new Set(['css', 'scss', 'less']);
  const JS_LANGS = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
  const syntaxOf = (model) => {
    if (!model || model.isDisposed?.()) return null;
    const lang = model.getLanguageId();
    if (lang === 'html') return 'html';
    if (CSS_LANGS.has(lang)) return 'css';
    if (JS_LANGS.has(lang) && /\.(jsx|tsx)$/i.test(model.uri.path)) return 'jsx';
    return null;
  };

  // What Tab would expand at `pos`: {abbr, range, snippet, syntax}, or null.
  function candidateIn(model, pos) {
    const syntax = syntaxOf(model);
    if (!syntax || !enabled()) return null;
    const line = model.getLineContent(pos.lineNumber);
    const col = pos.column - 1;
    if (!col || /\s/.test(line[col - 1]) || /[\w$]/.test(line[col] || '')) return null;
    const result = (x, snippet, kind) => (snippet == null ? null : {
      abbr: x.abbr, snippet, syntax: kind, range: new monaco.Range(pos.lineNumber, x.start + 1, pos.lineNumber, pos.column),
    });
    const css = (prefix, lineComments) => {
      const x = extractCss(line, col);
      if (!x) return null;
      if (!cssDeclarationAt(prefix + line.slice(0, x.start), lineComments)) return null;
      return result(x, expandCss(x.abbr), 'css');
    };
    if (syntax === 'css') {
      const lineStart = model.getOffsetAt({ lineNumber: pos.lineNumber, column: 1 });
      return css(model.getValue().slice(0, lineStart).replace(/\r\n/g, '\n'), model.getLanguageId() !== 'css');
    }
    if (syntax === 'html') {
      // The abbreviation starts after the last tag or comment end on the line.
      let bound = 0;
      for (const m of line.slice(0, col).matchAll(/<[^<>]*>|-->/g)) bound = m.index + m[0].length;
      const x = extractMarkup(line, col, bound);
      const tree = x && (x.abbr === '!' || x.abbr === 'html:5' ? [] : parse(x.abbr));
      const markup = !!tree && htmlAccepts(x.abbr, tree);
      // The line alone rules most words out; only then the scan from the start of the file (tenths of a second per
      // keystroke in a 5 MB file) says whether the caret is in text or in <style>.
      const cx = extractCss(line, col);
      if (!markup && !(cx && expandCss(cx.abbr))) return null;
      const at = scanAt(model, model.getOffsetAt(pos));
      if (at.state === 'raw' && at.raw === 'style') {
        const lineStart = model.getOffsetAt({ lineNumber: pos.lineNumber, column: 1 });
        return css(model.getValue().slice(at.rawStart, Math.max(at.rawStart, lineStart)), false);
      }
      if (at.state !== 'text' || !markup) return null;
      return result(x, expandMarkup(x.abbr, { parent: at.open.at(-1) || '' }), 'html');
    }
    // JSX in .jsx / .tsx.
    const x = extractMarkup(line, col);
    if (!x || !/^[A-Za-z.#(]/.test(x.abbr)) return null;
    if (tokenTypeAt(model, pos.lineNumber, x.start + 1) !== 0) return null; // a comment, string or regex
    if (!jsxContext(model, pos.lineNumber, line.slice(0, x.start))) return null;
    const tree = parse(x.abbr);
    if (!tree || !jsxAccepts(x.abbr, tree)) return null;
    return result(x, expandMarkup(x.abbr, { jsx: true }), 'jsx');
  }

  let cache = null;
  function candidateAt(editor) {
    const model = editor.getModel();
    const sels = editor.getSelections();
    if (!model || !sels || sels.length !== 1 || !sels[0].isEmpty()) return null;
    const pos = sels[0].getPosition();
    const version = model.getVersionId();
    if (cache && cache.model === model && cache.version === version && cache.line === pos.lineNumber && cache.column === pos.column && cache.on === enabled()) return cache.value;
    let value = candidateIn(model, pos);
    // A live template of the same name (JavaScript and TypeScript) keeps its Tab.
    if (value && value.syntax === 'jsx' && ide.liveTemplates?.candidateAt?.(editor)) value = null;
    cache = { model, version, line: pos.lineNumber, column: pos.column, on: enabled(), value };
    return value;
  }

  function expand(editor) {
    const c = candidateAt(editor);
    if (!c || editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
    editor.trigger('emmet', 'hideSuggestWidget', {});
    editor.pushUndoStop();
    editor.setSelection(c.range);
    editor.getContribution('snippetController2').insert(c.snippet, { undoStopBefore: false });
    editor.focus();
    return true;
  }

  // ---------- Tab ----------
  const editors = new Map(); // editor -> recompute its emmetAtCaret context key
  const focused = () => [...editors.keys()].find((e) => e.hasTextFocus()) || null;
  ide.onEditor((editor) => {
    const key = editor.createContextKey('emmetAtCaret', false);
    const update = () => key.set(!!candidateAt(editor));
    editors.set(editor, update);
    editor.onDidChangeCursorPosition(update);
    editor.onDidChangeModel(update);
    editor.onDidChangeModelLanguage?.(update);
    editor.onDidDispose(() => editors.delete(editor));
  });
  ide.on('settingsChanged', (k) => { if (k === ENABLED) for (const update of editors.values()) update(); });
  monaco.editor.addCommand({ id: 'emmet.expandAbbreviation', run: () => { const e = focused(); if (e) expand(e); } });
  // While the completion list shows, Tab accepts its item (the abbreviation's own item when it is selected).
  monaco.editor.addKeybindingRules([{
    keybinding: monaco.KeyCode.Tab, command: 'emmet.expandAbbreviation',
    when: 'emmetAtCaret && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode && !editorTabMovesFocus',
  }]);

  // ---------- completion list ----------
  const previewOf = (snippet) => snippet
    .replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '').replace(/\\(.)/g, '$1').replace(/\t/g, '  ');
  const PREVIEW_LANG = { html: 'html', css: 'css', jsx: 'javascript' };
  const provider = {
    provideCompletionItems(model, position, context) {
      const c = candidateIn(model, position);
      if (!c) return undefined;
      // A plain word (p, div, bd) is listed only on Ctrl+Space, so typing prose or property names does not keep
      // offering it; abbreviations with operators, numbers or values are listed as they are typed.
      if (/^[A-Za-z][\w-]*$/.test(c.abbr) && context?.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) return undefined;
      return {
        incomplete: true,
        suggestions: [{
          label: { label: c.abbr, description: tr('Emmet abbreviation') }, kind: monaco.languages.CompletionItemKind.Snippet,
          detail: tr('Emmet abbreviation'), documentation: { value: '```' + PREVIEW_LANG[c.syntax] + '\n' + previewOf(c.snippet) + '\n```' },
          insertText: c.snippet, insertTextRules: SNIPPET, range: c.range, filterText: c.abbr, sortText: '!', preselect: true,
        }],
      };
    },
  };
  for (const lang of ['html', 'css', 'scss', 'less', 'javascript', 'typescript']) monaco.languages.registerCompletionItemProvider(lang, provider);

  // ---------- Settings › Editor › Smart Keys ----------
  const section = {
    defaults: DEFAULTS,
    keywords: 'emmet zen coding abbreviation expand tab html css scss less jsx 에밋 약어 확장 펼치기',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Emmet'));
      s.appendChild(ctx.ui.checkbox(ENABLED, tr('Expand Emmet abbreviations with Tab')));
      s.appendChild(ide.util.el('div', 'muted settings-note',
        tr('In HTML, CSS, SCSS and Less files, and for markup in .jsx and .tsx files: ul>li*3 followed by Tab writes a list with three items, m10 writes margin: 10px;.')));
    },
  };
  (ide.smartKeysSections ||= []).push(section);
  ide.on('ready', () => {
    if ((ide.settingsPages || []).some((p) => p.id === 'smart-keys')) return;
    (ide.settingsPages ||= []).push({ id: 'emmet-smart-keys', group: 'editor', title: () => tr('Smart Keys'), ...section });
  });

  // expand(abbr, {syntax: 'html' | 'jsx' | 'css', parent}): the snippet for any valid abbreviation, or null (the rules
  // for which words Tab expands are in candidateIn).
  ide.emmet = {
    expand(abbr, { syntax = 'html', parent = '' } = {}) {
      if (syntax === 'css' || CSS_LANGS.has(syntax)) return expandCss(abbr);
      return expandMarkup(abbr, { jsx: syntax === 'jsx', parent });
    },
    candidateAt, candidateIn, expandEditor: expand, lorem, keys: { ENABLED },
  };
})();
