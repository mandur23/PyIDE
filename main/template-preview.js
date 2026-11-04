// Server templates made into pages the HTML preview can show without the server. Pure: templates come from load(name).
// - Django and Jinja2 (renderTemplate): {% extends %} and {% block %} are put together, {% include %} is inlined,
//   static file URLs ({% static 'x' %}, url_for('static', filename='x'), FastAPI's url_for('static', path='x'), a
//   blueprint's url_for('bp.static', ...)) become /static/x, and every other tag and value the server would fill in is
//   left empty. Both branches of an if and one pass of a for show, so the page keeps its layout.
// - Thymeleaf (renderThymeleaf), whose templates are HTML already: th:href and th:src links (@{/css/x.css}) are used
//   where the tag has no plain href or src, and th:replace, th:insert and th:include put in their fragments.
const MAX_DEPTH = 10;
const TOKEN = /\{%-?([\s\S]*?)-?%\}|\{\{-?([\s\S]*?)-?\}\}|\{#[\s\S]*?#\}/g;
const LITERAL = /\{%-?\s*(raw|verbatim)\s*-?%\}([\s\S]*?)\{%-?\s*end\1\s*-?%\}/g;
// Tags whose body is a definition or a comment, never part of the page.
const SKIPPED = { macro: 'endmacro', comment: 'endcomment', call: 'endcall' };

const quoted = (s) => /["']([^"']+)["']/.exec(s)?.[1] || null;
const staticUrl = (name) => `/static/${name.replace(/^\/+/, '')}`;

function tokenize(text) {
  const literals = [];
  const src = text.replace(LITERAL, (_m, _kind, body) => `\u0000${literals.push(body) - 1}\u0000`);
  const out = [];
  const text_ = (s) => {
    for (const part of s.split(/\u0000(\d+)\u0000/).map((p, i) => (i % 2 ? literals[Number(p)] : p))) if (part) out.push({ t: 'text', v: part });
  };
  let at = 0;
  for (const m of src.matchAll(TOKEN)) {
    text_(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      const body = m[1].trim();
      const name = /^\w+/.exec(body)?.[0] || '';
      out.push({ t: 'tag', name, args: body.slice(name.length).trim() });
    } else if (m[2] !== undefined) out.push({ t: 'expr', v: m[2].trim() });
  }
  text_(src.slice(at));
  return out;
}

function parse(tokens) {
  const root = [];
  const stack = [{ body: root }];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const top = stack[stack.length - 1].body;
    if (tok.t !== 'tag') { top.push(tok); continue; }
    if (SKIPPED[tok.name]) {
      let depth = 1;
      while (++i < tokens.length && depth) {
        if (tokens[i].t !== 'tag') continue;
        if (tokens[i].name === tok.name) depth++;
        else if (tokens[i].name === SKIPPED[tok.name]) depth--;
      }
      i--;
      continue;
    }
    if (tok.name === 'block') {
      const node = { t: 'block', name: tok.args.split(/\s+/)[0], body: [] };
      top.push(node);
      stack.push(node);
    } else if (tok.name === 'endblock') {
      if (stack.length > 1) stack.pop();
    } else top.push(tok);
  }
  return root;
}

function collectBlocks(nodes, into) {
  for (const n of nodes) {
    if (n.t !== 'block') continue;
    if (!into[n.name]) into[n.name] = n;
    collectBlocks(n.body, into);
  }
  return into;
}

async function renderTemplate(text, { load, depth = 0, blocks = {} } = {}) {
  const nodes = parse(tokenize(text));
  const ext = nodes.find((n) => n.t === 'tag' && n.name === 'extends');
  const parentName = ext && quoted(ext.args);
  if (parentName && depth < MAX_DEPTH) {
    const parent = await load(parentName);
    if (parent != null) return renderTemplate(parent, { load, depth: depth + 1, blocks: { ...collectBlocks(nodes, {}), ...blocks } });
  }
  return renderNodes(nodes, { load, depth, blocks, parentBody: null });
}

async function renderNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'expr') {
      if (/^(super\(\)|block\.super)$/.test(n.v)) out += ctx.parentBody ? await renderNodes(ctx.parentBody, { ...ctx, parentBody: null }) : '';
      else {
        const file = /^(?:request\.)?url_for\(\s*["'](?:[\w.]+\.)?static["']\s*,\s*(?:filename|path)\s*=\s*["']([^"']+)["']/.exec(n.v) || /^static\(\s*["']([^"']+)["']/.exec(n.v);
        if (file) out += staticUrl(file[1]);
      }
    } else if (n.t === 'block') {
      const over = ctx.blocks[n.name];
      out += over && over !== n
        ? await renderNodes(over.body, { ...ctx, parentBody: n.body })
        : await renderNodes(n.body, ctx);
    } else if (n.name === 'static') {
      const name = quoted(n.args);
      if (name) out += staticUrl(name);
    } else if (n.name === 'url') out += '#';
    else if (n.name === 'include' && ctx.depth < MAX_DEPTH) {
      const name = quoted(n.args);
      const inc = name && await ctx.load(name);
      if (inc != null) out += await renderTemplate(inc, { load: ctx.load, depth: ctx.depth + 1 });
    }
  }
  return out;
}

// ---------- Thymeleaf ----------
// A start tag, its attributes read with their quotes (th:if="${a > b}" holds a >).
const START_TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const attrOf = (attrs, name) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
const attrValue = (attrs, name) => { const m = attrOf(attrs, name); return m ? m[1] ?? m[2] : null; };
// @{/css/site.css}, @{~/x}, @{/order(id=${o.id})} -> the path; anything else (${...}, |...|) has none.
const linkPath = (expr) => /^@\{\s*~?([^\s(}]+)/.exec(expr.trim())?.[1] || null;
const isThymeleaf = (html) => /\sth:[\w-]+\s*=/.test(html);

// The end of the element whose start tag ends at `from` (after its closing tag), counting nested tags of its name.
function elementEnd(html, name, from) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html));) {
    if (m[1]) { if (--depth === 0) return re.lastIndex; } else if (!m[2].trim().endsWith('/')) depth++;
  }
  return html.length;
}
// Every element as {start, openEnd, end, name, attrs}, in document order.
function* elements(html) {
  for (const m of html.matchAll(START_TAG)) {
    const name = m[1];
    const openEnd = m.index + m[0].length;
    const closed = m[3] === '/' || VOID.has(name.toLowerCase());
    yield { start: m.index, openEnd, end: closed ? openEnd : elementEnd(html, name, openEnd), name, attrs: m[2] || '', closed };
  }
}
// "~{fragments/header :: nav(title)}", "fragments/header :: nav", "~{footer}", ":: #main" -> {template, selector}.
function fragmentRef(expr) {
  const v = expr.trim().replace(/^~\{([\s\S]*)\}$/, (_m, inner) => inner).trim();
  const [template, selector] = v.split('::').map((x) => x.trim());
  return { template: template && template !== 'this' ? template : null, selector: selector ? selector.replace(/\(.*$/, '').trim() : null };
}
function findFragment(html, selector) {
  for (const e of elements(html)) {
    const hit = selector.startsWith('#') ? attrValue(e.attrs, 'id') === selector.slice(1)
      : (attrValue(e.attrs, 'th:fragment') || '').replace(/\(.*$/, '').trim() === selector;
    if (hit) return { outer: html.slice(e.start, e.end), inner: e.closed ? '' : html.slice(e.openEnd, html.lastIndexOf('<', e.end - 1)) };
  }
  return null;
}

async function renderThymeleaf(html, { load, depth = 0 } = {}) {
  if (!isThymeleaf(html)) return html;
  const own = html;
  // Fragments first, one host at a time from the top, so a fragment's own hosts are put in after it.
  for (let n = 0; n < 200; n++) {
    let host = null;
    for (const e of elements(html)) {
      const kind = ['th:replace', 'th:insert', 'th:include'].find((a) => attrOf(e.attrs, a));
      if (kind) { host = { ...e, kind, ref: fragmentRef(attrValue(e.attrs, kind)) }; break; }
    }
    if (!host) break;
    let source = own;
    if (host.ref.template && depth < MAX_DEPTH) source = await load(/\.html?$/i.test(host.ref.template) ? host.ref.template : `${host.ref.template}.html`);
    const frag = source == null ? null : host.ref.selector ? findFragment(source, host.ref.selector) : { outer: source, inner: source };
    const strip = (s) => s.replace(new RegExp(`\\s${host.kind}\\s*=\\s*(?:"[^"]*"|'[^']*')`), '');
    const open = strip(html.slice(host.start, host.openEnd));
    const closeAt = host.closed ? host.end : html.lastIndexOf('<', host.end - 1);
    const close = html.slice(closeAt, host.end);
    // A fragment that cannot be found leaves the host as it is, so its placeholder content still shows.
    const put = !frag ? open + html.slice(host.openEnd, closeAt) + close
      : host.kind === 'th:replace' ? frag.outer
      : host.closed ? open.replace(/\s*\/>$/, '>') + (host.kind === 'th:insert' ? frag.outer : frag.inner) + `</${host.name}>`
      : open + (host.kind === 'th:insert' ? frag.outer : frag.inner) + close;
    html = html.slice(0, host.start) + put + html.slice(host.end);
  }
  // Links: a th:href or th:src the tag has no plain href or src for.
  return html.replace(START_TAG, (tag, name, attrs, slash) => {
    let add = '';
    for (const a of ['href', 'src']) {
      const url = attrValue(attrs || '', `th:${a}`);
      const p = url && !attrOf(attrs || '', a) && linkPath(url);
      if (p) add += ` ${a}="${p.replace(/"/g, '&quot;')}"`;
    }
    return add ? `<${name}${attrs || ''}${add}${slash ? ' /' : ''}>` : tag;
  });
}

module.exports = { renderTemplate, renderThymeleaf, isThymeleaf };
