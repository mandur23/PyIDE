// Python class diagrams, as PyCharm Professional's Diagrams › Show Diagram (Ctrl+Alt+Shift+U).
// main/features/diagrams.js reads the project's Python with `ast` (never importing it) and resolves bases and
// associations; this file chooses the classes to show, lays them out (a small Sugiyama-style layered layout: longest-path
// layering, barycenter ordering, then coordinates) and draws them as SVG in an editor tab with pan, zoom, selection,
// navigation, Add Class…, Delete and export to SVG or PNG.
(() => {
  const { el, basename, samePath, isUnder } = ide.util;
  const tr = (s, p) => (window.tr ? window.tr(s, p) : s);
  const SETTINGS = { fields: 'diagrams.showFields', methods: 'diagrams.showMethods', private: 'diagrams.showPrivate' };
  const isPy = (p) => /\.pyi?$/i.test(p || '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- geometry constants ----------
  const PAD_X = 10;
  const LINE = 18;
  const ICON = 20;
  const MIN_W = 120;
  const MAX_W = 520;
  const MARGIN = 40;
  const MAX_TEXT = 64;
  const FONT = () => getComputedStyle(document.body).fontFamily || 'Segoe UI, sans-serif';

  // SVG styling. Shown on screen through a <style> in the page (theme colours from the --dg-* variables in style.css);
  // an export gets the same rules with the variables replaced by the current theme's values.
  const svgCss = (font) => `
.dg-bg { fill: var(--dg-bg); }
.dg-box { fill: var(--dg-box); stroke: var(--dg-border); stroke-width: 1; }
.dg-head { fill: var(--dg-head); }
.dg-sep { stroke: var(--dg-border); stroke-width: 1; }
.dg-stereo { fill: var(--dg-muted); font: italic 11px ${font}; }
.dg-name { fill: var(--dg-text); font: 600 13px ${font}; }
.dg-abstract .dg-name { font-style: italic; }
.dg-module { fill: var(--dg-muted); font: 11px ${font}; }
.dg-mt { fill: var(--dg-text); font: 12px ${font}; }
.dg-vis-private .dg-mt, .dg-vis-protected .dg-mt { fill: var(--dg-muted); }
.dg-static .dg-mt { text-decoration: underline; }
.dg-abs .dg-mt { font-style: italic; }
.dg-ic { stroke: none; }
.dg-ic-t { fill: #fff; font: 600 9px ${font}; }
.dg-ic-f { fill: var(--dg-field); }
.dg-ic-e { fill: var(--dg-enum); }
.dg-ic-m { fill: var(--dg-method); }
.dg-ic-p { fill: var(--dg-property); }
.dg-ic-c { fill: var(--dg-method); }
.dg-ic-s { fill: var(--dg-method); }
.dg-lock { fill: var(--dg-muted); font: 10px ${font}; }
.dg-line { fill: none; stroke-width: 1.2; }
.dg-ext .dg-line { stroke: var(--dg-ext); }
.dg-ext .dg-arrow { fill: var(--dg-box); stroke: var(--dg-ext); stroke-width: 1.2; }
.dg-assoc .dg-line { stroke: var(--dg-assoc); }
.dg-assoc .dg-arrow { fill: none; stroke: var(--dg-assoc); stroke-width: 1.2; }
.dg-elabel { fill: var(--dg-assoc); font: 11px ${font}; }
.dg-node.dg-sel .dg-box { stroke: var(--dg-sel); stroke-width: 2.5; }
.dg-node.dg-rel .dg-box { stroke: var(--dg-sel); }
.dg-has-sel .dg-node:not(.dg-rel):not(.dg-sel) { opacity: 0.35; }
.dg-has-sel .dg-edge:not(.dg-hl) { opacity: 0.2; }
.dg-edge.dg-hl .dg-line { stroke: var(--dg-sel); stroke-width: 2; }
.dg-edge.dg-hl .dg-arrow { stroke: var(--dg-sel); }
`;
  const VARS = ['--dg-bg', '--dg-box', '--dg-head', '--dg-border', '--dg-text', '--dg-muted', '--dg-field', '--dg-enum',
    '--dg-method', '--dg-property', '--dg-ext', '--dg-assoc', '--dg-sel'];
  const pageStyle = document.createElement('style');
  pageStyle.id = 'dgSvgStyle';
  pageStyle.textContent = svgCss(FONT());
  document.head.appendChild(pageStyle);

  // ---------- members ----------
  const visibility = (name) => (/^__.*__$/.test(name) ? 'public' : name.startsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public');
  const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
  function memberRows(cls, opts) {
    const rows = { fields: [], methods: [] };
    const keep = (name) => opts.private || visibility(name) === 'public';
    if (opts.fields) {
      for (const f of cls.fields) {
        if (!keep(f.name)) continue;
        const enumMember = f.kind === 'enum';
        rows.fields.push({ icon: enumMember ? 'e' : 'f', vis: visibility(f.name), kind: f.kind, name: f.name,
          text: clip(enumMember || !f.type ? f.name : `${f.name}: ${f.type}`), line: f.line, static: f.kind === 'classvar' });
      }
    }
    if (opts.methods) {
      for (const m of cls.methods) {
        if (!keep(m.name)) continue;
        const ret = m.returns ? `: ${m.returns}` : '';
        const text = m.property ? `${m.name}${ret}` : `${m.async ? 'async ' : ''}${m.name}(${m.params})${ret}`;
        rows.methods.push({ icon: m.property ? 'p' : m.classmethod ? 'c' : m.static ? 's' : 'm', vis: visibility(m.name), name: m.name,
          text: clip(text), line: m.line, static: m.static, abstract: m.abstract, async: m.async, property: m.property, classmethod: m.classmethod });
      }
    }
    return rows;
  }

  // ---------- measuring ----------
  const measureCtx = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  function textWidth(text, font) {
    const k = `${font}\u0000${text}`;
    let w = widthCache.get(k);
    if (w === undefined) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
      if (widthCache.size > 20000) widthCache.clear();
      widthCache.set(k, w);
    }
    return w;
  }
  // Box size and the y of each part.
  function boxOf(cls, opts) {
    const font = FONT();
    const rows = memberRows(cls, opts);
    const stereo = cls.stereotype ? `«${cls.stereotype}»` : '';
    let y = 6;
    const parts = {};
    if (stereo) { parts.stereoY = y + 11; y += 15; }
    parts.nameY = y + 13; y += 18;
    parts.moduleY = y + 11; y += 16;
    const headH = y + 2;
    let w = Math.max(textWidth(cls.name, `600 13px ${font}`), textWidth(cls.module, `11px ${font}`), stereo ? textWidth(stereo, `italic 11px ${font}`) : 0) + 2 * PAD_X;
    y = headH;
    const sections = [];
    for (const key of ['fields', 'methods']) {
      if (!opts[key] || !rows[key].length) continue;
      const sec = { key, y, rows: rows[key] };
      y += 4;
      for (const r of rows[key]) {
        r.y = y + 13;
        w = Math.max(w, ICON + textWidth(r.text, `12px ${font}`) + 2 * PAD_X + (r.vis !== 'public' ? 10 : 0));
        y += LINE;
      }
      y += 4;
      sections.push(sec);
    }
    return { w: Math.ceil(Math.min(MAX_W, Math.max(MIN_W, w))), h: Math.ceil(y), headH, sections, stereo, ...parts };
  }

  // ---------- layout ----------
  // nodes: [{id, w, h}]; edges: [{from, to, kind: 'extends' | 'assoc'}] (extends: from the subclass to its base).
  // Returns {pos: Map(id -> {x, y, w, h}), routes: [{from, to, kind, points}], width, height, ms}.
  function layoutGraph(nodes, edges, { hgap = 36, vgap = 64, cgap = 56 } = {}) {
    const t0 = performance.now();
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const N = nodes.length;
    const parents = Array.from({ length: N }, () => []);
    const children = Array.from({ length: N }, () => []);
    const seenPair = new Set();
    for (const e of edges) {
      if (e.kind !== 'extends') continue;
      const c = index.get(e.from);
      const p = index.get(e.to);
      if (c === undefined || p === undefined || c === p || seenPair.has(`${c}>${p}`)) continue;
      seenPair.add(`${c}>${p}`);
      parents[c].push(p);
      children[p].push(c);
    }
    // Inheritance cannot loop in valid code, but a half-typed file can: drop the edges that close a cycle.
    const state = new Uint8Array(N);
    const dropEdge = (c, p) => { parents[c] = parents[c].filter((x) => x !== p); children[p] = children[p].filter((x) => x !== c); };
    for (let s = 0; s < N; s++) {
      if (state[s]) continue;
      const stack = [[s, 0]];
      state[s] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, i] = top;
        if (i < parents[v].length) {
          top[1]++;
          const p = parents[v][i];
          if (state[p] === 1) { dropEdge(v, p); top[1]--; } else if (!state[p]) { state[p] = 1; stack.push([p, 0]); }
        } else { state[v] = 2; stack.pop(); }
      }
    }
    // Components over inheritance.
    const comp = new Int32Array(N).fill(-1);
    const comps = [];
    for (let s = 0; s < N; s++) {
      if (comp[s] >= 0) continue;
      const list = [s];
      comp[s] = comps.length;
      for (let i = 0; i < list.length; i++) {
        for (const n of [...parents[list[i]], ...children[list[i]]]) if (comp[n] < 0) { comp[n] = comps.length; list.push(n); }
      }
      comps.push(list);
    }

    const pos = new Map();
    const routes = [];
    const items = [];
    for (const list of comps) {
      if (list.length === 1) {
        const n = nodes[list[0]];
        items.push({ w: n.w, h: n.h, single: true, place: (dx, dy) => pos.set(n.id, { x: dx, y: dy, w: n.w, h: n.h }) });
      } else items.push(layoutComponent(list));
    }

    function layoutComponent(list) {
      // Longest-path layering: a base sits above every subclass (layer = 1 + the deepest base's layer); a class
      // without bases then moves down next to its highest subclass, so short hierarchies do not stretch.
      const layer = new Map();
      const depth = (v) => {
        if (layer.has(v)) return layer.get(v);
        layer.set(v, 0);
        let L = 0;
        for (const p of parents[v]) L = Math.max(L, depth(p) + 1);
        layer.set(v, L);
        return L;
      };
      for (const v of list) depth(v);
      const byLayerDesc = [...list].sort((a, b) => layer.get(b) - layer.get(a));
      for (const v of byLayerDesc) {
        if (!children[v].length) continue;
        if (parents[v].length && children[v].length <= parents[v].length) continue;
        const lowest = Math.min(...children[v].map((c) => layer.get(c))) - 1;
        if (lowest > layer.get(v)) layer.set(v, lowest);
      }
      const minL = Math.min(...list.map((v) => layer.get(v)));
      for (const v of list) layer.set(v, layer.get(v) - minL);
      const layerCount = Math.max(...list.map((v) => layer.get(v))) + 1;

      // Layered graph with dummy nodes on edges that span several layers.
      const lnodes = [];
      const real = new Map();
      for (const v of list) {
        const ln = { v, w: nodes[v].w, h: nodes[v].h, layer: layer.get(v), up: [], down: [], x: 0, order: 0 };
        real.set(v, ln);
        lnodes.push(ln);
      }
      const chains = [];
      for (const c of list) {
        for (const p of parents[c]) {
          const chain = [real.get(p)];
          for (let L = layer.get(p) + 1; L < layer.get(c); L++) {
            const d = { dummy: true, w: 12, h: 0, layer: L, up: [], down: [], x: 0, order: 0 };
            lnodes.push(d);
            chain.push(d);
          }
          chain.push(real.get(c));
          for (let i = 0; i + 1 < chain.length; i++) { chain[i].down.push(chain[i + 1]); chain[i + 1].up.push(chain[i]); }
          chains.push({ from: nodes[c].id, to: nodes[p].id, chain });
        }
      }
      const layers = Array.from({ length: layerCount }, () => []);
      // Initial order: depth-first from the top layer, so subtrees start together.
      const placed = new Set();
      const visit = (n) => {
        if (placed.has(n)) return;
        placed.add(n);
        layers[n.layer].push(n);
        for (const d of n.down) visit(d);
      };
      for (const n of lnodes.filter((x) => !x.up.length).sort((a, b) => a.layer - b.layer)) visit(n);
      for (const n of lnodes) visit(n);
      const setOrder = () => layers.forEach((l) => l.forEach((n, i) => { n.order = i; }));
      setOrder();

      // Barycenter ordering, alternating down and up sweeps; the order with the fewest crossings wins.
      const crossings = () => {
        let total = 0;
        for (let L = 0; L + 1 < layers.length; L++) {
          const pairs = [];
          for (const u of layers[L]) for (const d of u.down) pairs.push([u.order, d.order]);
          pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          const size = layers[L + 1].length + 1;
          const tree = new Int32Array(size + 1);
          let seen = 0;
          for (const [, b] of pairs) {
            let q = 0;
            for (let i = b + 1; i > 0; i -= i & -i) q += tree[i];
            total += seen - q;
            for (let i = b + 1; i <= size; i += i & -i) tree[i]++;
            seen++;
          }
        }
        return total;
      };
      let best = crossings();
      let bestOrder = layers.map((l) => [...l]);
      for (let iter = 0; iter < 24 && best > 0; iter++) {
        const down = iter % 2 === 0;
        const seq = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
        for (const L of seq) {
          const l = layers[L];
          const bary = new Map(l.map((n) => {
            const nb = down ? n.up : n.down;
            return [n, nb.length ? nb.reduce((s, x) => s + x.order, 0) / nb.length : n.order];
          }));
          l.sort((a, b) => bary.get(a) - bary.get(b) || a.order - b.order);
          l.forEach((n, i) => { n.order = i; });
        }
        const c = crossings();
        if (c < best) { best = c; bestOrder = layers.map((l) => [...l]); }
      }
      bestOrder.forEach((l, L) => { layers[L] = l; });
      setOrder();

      // Coordinates: each layer keeps its order and minimum gaps, and its nodes move as close as they can to the
      // mean of their neighbours in the layer just placed (a least-squares fit under the order constraints, solved by
      // pooling adjacent violators).
      const gapOf = (a, b) => (a.dummy || b.dummy ? hgap / 3 : hgap);
      const place = (l, desired) => {
        const offs = [];
        let acc = 0;
        for (let i = 0; i < l.length; i++) {
          if (i) acc += l[i - 1].w / 2 + gapOf(l[i - 1], l[i]) + l[i].w / 2;
          offs.push(acc);
        }
        const blocks = [];
        for (let i = 0; i < l.length; i++) {
          let b = { sum: desired[i] - offs[i], n: 1, start: i };
          b.val = b.sum;
          while (blocks.length && blocks[blocks.length - 1].val > b.val) {
            const prev = blocks.pop();
            b = { sum: prev.sum + b.sum, n: prev.n + b.n, start: prev.start };
            b.val = b.sum / b.n;
          }
          blocks.push(b);
        }
        for (const b of blocks) for (let i = b.start; i < b.start + b.n; i++) l[i].x = b.val + offs[i];
      };
      layers.forEach((l) => place(l, l.map(() => 0)));
      const mean = (ns, fallback) => (ns.length ? ns.reduce((s, n) => s + n.x, 0) / ns.length : fallback);
      for (let iter = 0; iter < 8; iter++) {
        const down = iter % 2 === 0;
        const seq = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
        for (const L of seq) place(layers[L], layers[L].map((n) => mean(down ? n.up : n.down, n.x)));
      }
      for (const l of layers) place(l, l.map((n) => mean([...n.up, ...n.down], n.x)));
      let minX = Infinity;
      let maxX = -Infinity;
      for (const n of lnodes) { minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2); }
      const layerTop = [];
      const layerH = layers.map((l) => Math.max(0, ...l.map((n) => n.h)));
      let y = 0;
      for (let L = 0; L < layers.length; L++) { layerTop.push(y); y += layerH[L] + vgap; }
      const height = y - vgap;
      const width = maxX - minX;
      return {
        w: width, h: height,
        place(dx, dy) {
          const X = (n) => n.x - minX + dx;
          for (const n of lnodes) if (!n.dummy) pos.set(nodes[n.v].id, { x: X(n) - n.w / 2, y: layerTop[n.layer] + dy, w: n.w, h: n.h });
          // Orthogonal routes: up from the subclass's top to the middle of the gap above it, across, and so on to the
          // base's bottom centre. A class with several bases leaves from spread points on its top edge.
          const mid = (L) => layerTop[L] + layerH[L] + vgap / 2 + dy;
          const outCount = new Map();
          for (const ch of chains) {
            const child = ch.chain[ch.chain.length - 1];
            const k = child.v;
            const n = parents[k].length;
            const i = outCount.get(k) || 0;
            outCount.set(k, i + 1);
            const sorted = [...parents[k]].sort((a, b) => real.get(a).x - real.get(b).x);
            const slot = sorted.indexOf(index.get(ch.to));
            const spread = n > 1 ? Math.min(24, (child.w * 0.6) / (n - 1)) : 0;
            const sx = X(child) + (n > 1 ? (slot - (n - 1) / 2) * spread : 0);
            const pts = [[sx, layerTop[child.layer] + dy]];
            let curX = sx;
            for (let i2 = ch.chain.length - 2; i2 >= 0; i2--) {
              const node = ch.chain[i2];
              const my = mid(node.layer);
              const nx = X(node);
              pts.push([curX, my], [nx, my]);
              curX = nx;
              if (node.dummy) pts.push([nx, layerTop[node.layer] + dy]);
              else pts.push([nx, layerTop[node.layer] + node.h + dy]);
            }
            routes.push({ from: ch.from, to: ch.to, kind: 'extends', points: simplify(pts) });
          }
        },
      };
    }

    // Shelf packing: hierarchies first (largest first), then single classes, in rows about as wide as the whole
    // diagram is tall times 1.6.
    const area = items.reduce((s, it) => s + (it.w + cgap) * (it.h + cgap), 0);
    const target = Math.max(...items.map((it) => it.w), Math.sqrt(area * 1.6));
    const ordered = [...items.filter((it) => !it.single).sort((a, b) => b.w * b.h - a.w * a.h), ...items.filter((it) => it.single)];
    let x = 0;
    let y = 0;
    let rowH = 0;
    let width = 0;
    for (const it of ordered) {
      if (x > 0 && x + it.w > target) { x = 0; y += rowH + cgap; rowH = 0; }
      it.place(x, y);
      x += it.w + cgap;
      rowH = Math.max(rowH, it.h);
      width = Math.max(width, x - cgap);
    }
    const height = items.length ? y + rowH : 0;
    // Associations: straight from border to border.
    for (const e of edges) {
      if (e.kind !== 'assoc') continue;
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b || e.from === e.to) continue;
      routes.push({ ...e, points: borderLine(a, b) });
    }
    return { pos, routes, width, height, ms: performance.now() - t0 };
  }

  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
      if (out.length >= 2) {
        const a = out[out.length - 2];
        const b = last;
        if ((Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01)) out.pop();
      }
      out.push(p);
    }
    return out;
  }

  // The segment between two boxes' centres, cut at both borders.
  function borderLine(a, b) {
    const ca = [a.x + a.w / 2, a.y + a.h / 2];
    const cb = [b.x + b.w / 2, b.y + b.h / 2];
    const cut = (box, from, to) => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const tx = dx ? (box.w / 2) / Math.abs(dx) : Infinity;
      const ty = dy ? (box.h / 2) / Math.abs(dy) : Infinity;
      const t = Math.min(tx, ty, 1);
      return [from[0] + dx * t, from[1] + dy * t];
    };
    return [cut(a, ca, cb), cut(b, cb, ca)];
  }

  // ---------- SVG markup ----------
  function arrowHead(points, kind) {
    const [x2, y2] = points[points.length - 1];
    const [x1, y1] = points[points.length - 2];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const size = kind === 'extends' ? 12 : 9;
    const half = kind === 'extends' ? 6.5 : 5;
    const bx = x2 - ux * size;
    const by = y2 - uy * size;
    const l = [bx - uy * half, by + ux * half];
    const r = [bx + uy * half, by - ux * half];
    const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    return kind === 'extends'
      ? `<polygon class="dg-arrow" points="${f(l)} ${f([x2, y2])} ${f(r)}"/>`
      : `<polyline class="dg-arrow" points="${f(l)} ${f([x2, y2])} ${f(r)}"/>`;
  }
  function edgeMarkup(r, i) {
    const pts = r.points;
    const d = `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L')}`;
    const cls = r.kind === 'extends' ? 'dg-ext' : 'dg-assoc';
    let extra = '';
    if (r.kind === 'assoc') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      if (r.label) extra += `<text class="dg-elabel" x="${(mx + 4).toFixed(1)}" y="${(my - 4).toFixed(1)}">${esc(r.label)}</text>`;
      if (r.many) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        extra += `<text class="dg-elabel dg-mult" x="${(b[0] - ((b[0] - a[0]) / len) * 18 + 6).toFixed(1)}" y="${(b[1] - ((b[1] - a[1]) / len) * 18 - 4).toFixed(1)}">*</text>`;
      }
    }
    return `<g class="dg-edge ${cls}" data-i="${i}" data-from="${esc(r.from)}" data-to="${esc(r.to)}"><path class="dg-line" d="${d}"/>${arrowHead(pts, r.kind)}${extra}</g>`;
  }
  function nodeMarkup(cls, p, box) {
    const w = p.w;
    const flags = [cls.abstract ? ' dg-abstract' : '', cls.inScope === false ? ' dg-outside' : ''].join('');
    let s = `<g class="dg-node${flags}" data-id="${esc(cls.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`;
    s += `<title>${esc(`${cls.qualname} (${cls.module})${cls.externalBases.length ? `\n${cls.externalBases.join(', ')}` : ''}`)}</title>`;
    s += `<rect class="dg-box" width="${w}" height="${p.h}" rx="4"/>`;
    s += `<path class="dg-head" d="M0.5 ${box.headH} V4.5 a4 4 0 0 1 4 -4 H${w - 4.5} a4 4 0 0 1 4 4 V${box.headH} Z"/>`;
    if (box.stereo) s += `<text class="dg-stereo" x="${w / 2}" y="${box.stereoY}" text-anchor="middle">${esc(box.stereo)}</text>`;
    s += `<text class="dg-name" x="${w / 2}" y="${box.nameY}" text-anchor="middle">${esc(cls.name)}</text>`;
    s += `<text class="dg-module" x="${w / 2}" y="${box.moduleY}" text-anchor="middle">${esc(cls.module)}</text>`;
    for (const sec of box.sections) {
      s += `<line class="dg-sep" x1="0" y1="${sec.y}" x2="${w}" y2="${sec.y}"/>`;
      for (const r of sec.rows) {
        const rc = [`dg-m dg-m-${sec.key === 'fields' ? 'field' : 'method'}`, `dg-vis-${r.vis}`, r.static ? 'dg-static' : '', r.abstract ? 'dg-abs' : ''].filter(Boolean).join(' ');
        const cy = r.y - 4;
        s += `<g class="${rc}" data-name="${esc(r.name)}" data-line="${r.line}">`;
        s += `<circle class="dg-ic dg-ic-${r.icon}" cx="${PAD_X + 6}" cy="${cy}" r="6"/><text class="dg-ic-t" x="${PAD_X + 6}" y="${cy + 3}" text-anchor="middle">${r.icon}</text>`;
        let tx = PAD_X + ICON;
        if (r.vis !== 'public') { s += `<text class="dg-lock" x="${tx}" y="${r.y}">${r.vis === 'private' ? '−' : '#'}</text>`; tx += 10; }
        s += `<text class="dg-mt" x="${tx}" y="${r.y}">${esc(r.text)}</text></g>`;
      }
    }
    return `${s}</g>`;
  }

  // ---------- diagrams ----------
  const diagrams = new Map(); // tab id -> diagram
  let seq = 0;
  const progressFns = new Map();
  ide.api.on('diagrams:progress', (p) => progressFns.get(p?.id)?.(p));

  // The project interpreter, or a local one when the project runs remotely (the files are read here).
  function localInterp() {
    const cur = ide.currentInterp?.();
    const pick = cur && !cur.target ? cur : (ide.interps || []).find((i) => !i.target && i.cmd && !i.invalid);
    return pick ? { cmd: pick.cmd, args: pick.args || [] } : null;
  }
  // Unsaved Python editors under the scope are read from their text, as the editor shows it.
  function overlayFor(paths) {
    const out = {};
    for (const t of ide.tabs) {
      if (t.kind !== 'file' || !isPy(t.path) || !ide.isDirty(t)) continue;
      if (paths.some((p) => isUnder(t.path, p))) out[t.path] = t.model.getValue();
    }
    return out;
  }

  async function requestModel(scope, label) {
    const id = `dg${Date.now().toString(36)}-${++seq}`;
    let cancelled = false;
    const task = ide.tasks?.start({
      title: tr('Building class diagram'), text: label, fraction: null,
      onCancel: () => { cancelled = true; ide.api.invoke('diagrams:cancel', id).catch(() => {}); },
    });
    progressFns.set(id, (p) => { if (p.total) task?.update({ fraction: p.done / p.total, text: tr('{done} of {total} files', { done: p.done, total: p.total }) }); });
    try {
      const r = await ide.api.invoke('diagrams:model', {
        id, interp: localInterp(), root: ide.root, scope, overlay: overlayFor(scope),
        maxFiles: ide.settings.get('diagrams.maxFiles', 5000), slowMs: api.slowMs || 0,
      });
      if (cancelled || r?.cancelled) return { cancelled: true };
      if (r?.error) {
        task?.fail();
        ide.notifications?.notify({ title: tr('Could not build the class diagram'), text: r.error, kind: 'error', raw: true });
        return { error: r.error };
      }
      task?.done();
      return r;
    } catch (err) {
      task?.fail();
      return { error: err?.message || String(err) };
    } finally {
      progressFns.delete(id);
    }
  }

  function indexModel(r) {
    const classes = new Map(r.classes.map((c) => [c.id, c]));
    const up = new Map();
    const down = new Map();
    for (const e of r.edges) {
      if (!classes.has(e.from) || !classes.has(e.to)) continue;
      if (!up.has(e.from)) up.set(e.from, []);
      if (!down.has(e.to)) down.set(e.to, []);
      up.get(e.from).push(e);
      down.get(e.to).push(e);
    }
    return { classes, edges: r.edges.filter((e) => classes.has(e.from) && classes.has(e.to)), up, down, stats: r.stats };
  }
  const ancestors = (m, id, out = new Set()) => {
    for (const e of m.up.get(id) || []) if (e.kind === 'extends' && !out.has(e.to)) { out.add(e.to); ancestors(m, e.to, out); }
    return out;
  };
  const descendants = (m, id, out = new Set()) => {
    for (const e of m.down.get(id) || []) if (e.kind === 'extends' && !out.has(e.from)) { out.add(e.from); descendants(m, e.from, out); }
    return out;
  };
  // What a new diagram shows: a scope's classes plus their project bases; for a class, the class, its bases and
  // subclasses (all levels) and the classes it is associated with in either direction.
  function initialSet(d) {
    const m = d.model;
    const out = new Set();
    if (d.focus && m.classes.has(d.focus)) {
      out.add(d.focus);
      ancestors(m, d.focus, out);
      descendants(m, d.focus, out);
      for (const e of m.up.get(d.focus) || []) if (e.kind === 'assoc') out.add(e.to);
      for (const e of m.down.get(d.focus) || []) if (e.kind === 'assoc') out.add(e.from);
    } else {
      for (const c of m.classes.values()) {
        if (!c.inScope || (d.file && !samePath(c.path, d.file))) continue;
        out.add(c.id);
        ancestors(m, c.id, out);
      }
    }
    return out;
  }

  const tabTitle = (d) => (d.focusName || basename(d.scope[0]) || tr('Diagram'));

  async function openDiagram({ scope, file, focusPath, focusLine, key }) {
    if (!ide.root && !scope.length) return null;
    let tabId = key ? `pyide-diagram:${key}` : null;
    // The same scope or class opens its existing tab again (refreshed).
    const reuse = (id) => {
      const old = diagrams.get(id);
      if (!old || !ide.findTab(id)) return null;
      ide.openCustomTab({ id, title: tabTitle(old), mount: () => {} });
      return old;
    };
    if (tabId && reuse(tabId)) { await refresh(diagrams.get(tabId)); return tabId; }
    const r = await requestModel(scope, ide.util.rel?.(scope[0]) || scope[0]);
    if (!r || r.cancelled || r.error) return null;
    const d = {
      scope, file, model: indexModel(r), shown: new Set(), added: new Set(), removed: new Set(), selected: null,
      opts: { fields: ide.settings.get(SETTINGS.fields, true), methods: ide.settings.get(SETTINGS.methods, true), private: ide.settings.get(SETTINGS.private, true) },
      view: { s: 1, tx: 20, ty: 20 }, fitted: false, stats: r.stats,
    };
    if (focusPath) {
      const hits = [...d.model.classes.values()].filter((c) => samePath(c.path, focusPath) && c.line <= focusLine && focusLine <= (c.endLine || c.line));
      const inner = hits.sort((a, b) => b.line - a.line)[0];
      if (inner) { d.focus = inner.id; d.focusName = inner.name; tabId = `pyide-diagram:class:${inner.id.toLowerCase()}`; }
      else { d.file = focusPath; tabId = `pyide-diagram:scope:${focusPath.toLowerCase()}`; }
      const old = reuse(tabId);
      if (old) {
        old.model = d.model;
        old.stats = d.stats;
        old.shown = new Set([...initialSet(old), ...old.added].filter((id) => old.model.classes.has(id) && !old.removed.has(id)));
        old.relayout?.();
        return tabId;
      }
    }
    d.tabId = tabId;
    d.shown = initialSet(d);
    diagrams.set(tabId, d);
    ide.openCustomTab({
      id: tabId, title: tabTitle(d), icon: '◇',
      mount: (host, tab) => mountDiagram(host, d, tab),
      onClose: () => { diagrams.delete(tabId); d.dispose?.(); },
    });
    return tabId;
  }

  async function refresh(d) {
    const r = await requestModel(d.projectLoaded ? [ide.root] : d.scope, tabTitle(d));
    if (!r || r.cancelled || r.error || !diagrams.has(d.tabId)) return false;
    d.model = indexModel(r);
    d.stats = r.stats;
    const keep = new Set([...initialSet(d), ...d.added].filter((id) => d.model.classes.has(id) && !d.removed.has(id)));
    d.shown = keep;
    if (d.selected && !keep.has(d.selected)) d.selected = null;
    d.relayout?.();
    return true;
  }

  // ---------- the view ----------
  function mountDiagram(host, d, tab) {
    host.classList.add('dg-root');
    host.dataset.state = 'loading';
    const bar = el('div', 'dg-toolbar');
    const status = el('span', 'dg-status');
    const canvas = el('div', 'dg-canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('data-user-text', '');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('dg-svg');
    // Panning moves this layer, not the <svg>: a transform on the <svg> itself lays out all its content again.
    const layer = el('div', 'dg-layer');
    layer.appendChild(svg);
    canvas.appendChild(layer);
    host.append(bar, canvas);

    const button = (cls, label, title, run, toggled) => {
      const b = el('button', `dg-btn ${cls}`, label);
      b.type = 'button';
      b.title = title;
      if (toggled !== undefined) { b.setAttribute('aria-pressed', String(!!toggled)); b.classList.add('dg-toggle'); }
      b.onclick = () => { run(b); canvas.focus(); };
      bar.appendChild(b);
      return b;
    };
    const sep = () => bar.appendChild(el('span', 'dg-sep-v'));
    const toggle = (key) => (b) => {
      d.opts[key] = !d.opts[key];
      b.setAttribute('aria-pressed', String(d.opts[key]));
      ide.settings.set(SETTINGS[key], d.opts[key]);
      relayout();
    };
    button('dg-fields', tr('Fields'), tr('Show Fields'), toggle('fields'), d.opts.fields);
    button('dg-methods', tr('Methods'), tr('Show Methods'), toggle('methods'), d.opts.methods);
    button('dg-private', tr('Private'), tr('Show Private Members'), toggle('private'), d.opts.private);
    sep();
    button('dg-zoom-in', '+', tr('Zoom In'), () => zoomBy(1.25));
    button('dg-zoom-out', '−', tr('Zoom Out'), () => zoomBy(0.8));
    button('dg-actual', '1:1', tr('Actual Size'), () => setScale(1));
    button('dg-fit', tr('Fit'), tr('Fit Content'), () => fit());
    sep();
    button('dg-add', tr('Add Class…'), tr('Add a class to the diagram'), () => addClass());
    button('dg-export-svg', 'SVG', tr('Export as SVG…'), () => exportSvg());
    button('dg-export-png', 'PNG', tr('Export as PNG…'), () => exportPng());
    button('dg-refresh', '⟳', tr('Refresh'), () => refresh(d));
    // Parse errors name files and Python's messages (user data), in the tooltip of a separate mark.
    const errMark = el('span', 'dg-errmark hidden', '⚠');
    errMark.setAttribute('data-user-text', '');
    bar.append(status, errMark);

    let layout = null;
    let boxes = new Map();
    let raf = 0;
    const applyView = () => {
      raf = 0;
      const { s, tx, ty } = d.view;
      if (layout) {
        const W = layout.width + 2 * MARGIN;
        const H = layout.height + 2 * MARGIN;
        if (svg._s !== s || svg._W !== W || svg._H !== H) {
          svg.setAttribute('width', String(Math.max(1, Math.round(W * s))));
          svg.setAttribute('height', String(Math.max(1, Math.round(H * s))));
          svg._s = s; svg._W = W; svg._H = H;
        }
      }
      layer.style.transform = `translate(${tx}px, ${ty}px)`;
      const scale = s.toFixed(3);
      if (host.dataset.scale !== scale) host.dataset.scale = scale;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(applyView); };

    function relayout() {
      const t0 = performance.now();
      const shown = [...d.shown].map((id) => d.model.classes.get(id)).filter(Boolean);
      boxes = new Map(shown.map((c) => [c.id, boxOf(c, d.opts)]));
      const nodes = shown.map((c) => ({ id: c.id, w: boxes.get(c.id).w, h: boxes.get(c.id).h }));
      const edges = d.model.edges.filter((e) => d.shown.has(e.from) && d.shown.has(e.to));
      layout = layoutGraph(nodes, edges);
      d.layout = layout;
      const t1 = performance.now();
      svg.setAttribute('viewBox', `${-MARGIN} ${-MARGIN} ${layout.width + 2 * MARGIN} ${layout.height + 2 * MARGIN}`);
      svg.innerHTML = markup(false);
      d.timing = { measureAndLayout: t1 - t0, layout: layout.ms, render: performance.now() - t1 };
      applySelection();
      applyView();
      const errs = d.stats?.errors?.length || 0;
      status.textContent = [
        tr('{n} classes', { n: shown.length }),
        errs === 1 ? tr('1 file could not be parsed') : errs ? tr('{n} files could not be parsed', { n: errs }) : '',
        d.stats?.truncated ? tr('Only the first {n} files were read', { n: d.stats.files }) : '',
      ].filter(Boolean).join(' · ');
      errMark.title = (d.stats?.errors || []).map((e) => `${ide.util.rel?.(e.path) || e.path}: ${e.error}`).join('\n');
      errMark.classList.toggle('hidden', !errs);
      host.dataset.state = 'ready';
      host.dataset.version = String((Number(host.dataset.version) || 0) + 1);
      if (!d.fitted && canvas.clientWidth) { d.fitted = true; fit(); }
    }
    d.relayout = relayout;

    // The diagram's markup; for an export, without selection classes.
    function markup(forExport) {
      let s = forExport ? `<rect class="dg-bg" x="${-MARGIN}" y="${-MARGIN}" width="${layout.width + 2 * MARGIN}" height="${layout.height + 2 * MARGIN}"/>` : '';
      s += '<g class="dg-edges">';
      layout.routes.forEach((r, i) => { s += edgeMarkup(r, i); });
      s += '</g><g class="dg-nodes">';
      for (const [id, p] of layout.pos) s += nodeMarkup(d.model.classes.get(id), p, boxes.get(id));
      return `${s}</g>`;
    }

    // ---------- selection ----------
    function related(id) {
      const out = new Set();
      for (const e of d.model.edges) {
        if (!d.shown.has(e.from) || !d.shown.has(e.to)) continue;
        if (e.from === id) out.add(e.to);
        if (e.to === id) out.add(e.from);
      }
      return out;
    }
    function applySelection() {
      const id = d.selected;
      svg.classList.toggle('dg-has-sel', !!id);
      const rel = id ? related(id) : new Set();
      for (const n of svg.querySelectorAll('.dg-node')) {
        n.classList.toggle('dg-sel', n.dataset.id === id);
        n.classList.toggle('dg-rel', rel.has(n.dataset.id));
      }
      for (const e of svg.querySelectorAll('.dg-edge')) e.classList.toggle('dg-hl', !!id && (e.dataset.from === id || e.dataset.to === id));
      host.dataset.selected = id || '';
    }
    const select = (id) => { d.selected = id; applySelection(); };

    function openClass(id) {
      const c = d.model.classes.get(id);
      if (c) ide.openFile(c.path, { line: c.line, col: c.col, focus: true });
    }
    function removeClass(id) {
      if (!id || !d.shown.has(id)) return;
      d.shown.delete(id);
      d.added.delete(id);
      d.removed.add(id);
      if (d.selected === id) d.selected = null;
      relayout();
    }
    async function addClass(pickId) {
      if (!d.projectLoaded && ide.root) {
        const r = await requestModel([ide.root], tr('Project'));
        if (r && !r.cancelled && !r.error) {
          d.model = indexModel(r);
          d.stats = r.stats;
          d.projectLoaded = true;
          for (const id of [...d.shown]) if (!d.model.classes.has(id)) d.shown.delete(id);
        }
      }
      let id = pickId;
      if (!id) {
        const items = [...d.model.classes.values()].filter((c) => !d.shown.has(c.id))
          .sort((a, b) => a.name.localeCompare(b.name) || a.module.localeCompare(b.module))
          .map((c) => ({ label: c.name, detail: c.module, value: c.id }));
        id = await ide.ui.pick({ placeholder: tr('Class name to add to the diagram'), items });
      }
      if (typeof id !== 'string' || !d.model.classes.has(id)) return null;
      d.shown.add(id);
      d.added.add(id);
      d.removed.delete(id);
      d.selected = id;
      relayout();
      reveal(id);
      return id;
    }

    // ---------- pan and zoom ----------
    const viewSize = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
    function setScale(s, anchor) {
      const ns = Math.max(0.1, Math.min(4, s));
      const { w, h } = viewSize();
      const [ax, ay] = anchor || [w / 2, h / 2];
      const { s: os, tx, ty } = d.view;
      d.view = { s: ns, tx: ax - ((ax - tx) / os) * ns, ty: ay - ((ay - ty) / os) * ns };
      schedule();
    }
    const zoomBy = (f, anchor) => setScale(d.view.s * f, anchor);
    function fit({ maxScale = 1 } = {}) {
      if (!layout) return;
      const { w, h } = viewSize();
      if (!w || !h) return;
      const W = layout.width + 2 * MARGIN;
      const H = layout.height + 2 * MARGIN;
      const s = Math.max(0.1, Math.min(maxScale, (w - 16) / W, (h - 16) / H));
      d.view = { s, tx: (w - W * s) / 2, ty: Math.max(8, (h - H * s) / 2) };
      schedule();
    }
    function reveal(id) {
      const p = layout?.pos.get(id);
      if (!p) return;
      const { w, h } = viewSize();
      const { s } = d.view;
      const cx = (p.x + p.w / 2 + MARGIN) * s;
      const cy = (p.y + p.h / 2 + MARGIN) * s;
      d.view = { s, tx: w / 2 - cx, ty: h / 2 - cy };
      schedule();
    }
    // Diagram coordinates of a client point.
    const toDiagram = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      return [(clientX - r.left - d.view.tx) / d.view.s - MARGIN, (clientY - r.top - d.view.ty) / d.view.s - MARGIN];
    };
    d.toDiagram = toDiagram;

    let space = false;
    let drag = null;
    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      const node = e.target.closest?.('.dg-node');
      if (e.button === 0 && node && !space) {
        select(node.dataset.id);
        return;
      }
      if (e.button === 0 || e.button === 1) {
        if (e.button === 0 && !space) select(null);
        e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, tx: d.view.tx, ty: d.view.ty };
        canvas.classList.add('dg-panning');
      }
    });
    const onMove = (e) => {
      if (!drag) return;
      d.view.tx = drag.tx + e.clientX - drag.x;
      d.view.ty = drag.ty + e.clientY - drag.y;
      schedule();
    };
    const onUp = () => { if (drag) { drag = null; canvas.classList.remove('dg-panning'); } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('dblclick', (e) => {
      const node = e.target.closest?.('.dg-node');
      if (node) openClass(node.dataset.id);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = canvas.getBoundingClientRect();
        zoomBy(Math.exp(-e.deltaY * 0.0015), [e.clientX - r.left, e.clientY - r.top]);
      } else {
        d.view.tx -= e.shiftKey ? e.deltaY : e.deltaX;
        d.view.ty -= e.shiftKey ? 0 : e.deltaY;
        schedule();
      }
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      const handled = {
        Delete: () => removeClass(d.selected),
        Escape: () => select(null),
        Enter: () => d.selected && openClass(d.selected),
        '+': () => zoomBy(1.25),
        '=': () => zoomBy(1.25),
        '-': () => zoomBy(0.8),
        ' ': () => { space = true; canvas.classList.add('dg-space'); },
      }[k];
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      handled();
    });
    canvas.addEventListener('keyup', (e) => { if (e.key === ' ') { space = false; canvas.classList.remove('dg-space'); } });
    canvas.addEventListener('blur', () => { space = false; canvas.classList.remove('dg-space'); });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const node = e.target.closest?.('.dg-node');
      if (node) {
        select(node.dataset.id);
        const id = node.dataset.id;
        ide.ui.contextMenu(e.clientX, e.clientY, [
          { label: tr('Jump to Source'), hint: 'Enter', run: () => openClass(id) },
          { label: tr('Remove from Diagram'), hint: 'Delete', run: () => removeClass(id) },
        ]);
      } else {
        ide.ui.contextMenu(e.clientX, e.clientY, [
          { label: tr('Add Class…'), run: () => addClass() },
          { label: tr('Fit Content'), run: () => fit() },
          { separator: true },
          { label: tr('Export as SVG…'), run: () => exportSvg() },
          { label: tr('Export as PNG…'), run: () => exportPng() },
        ]);
      }
    });

    // ---------- export ----------
    function exportMarkup() {
      const cs = getComputedStyle(host);
      let css = svgCss(FONT());
      for (const v of VARS) css = css.split(`var(${v})`).join(cs.getPropertyValue(v).trim() || '#888');
      const W = layout.width + 2 * MARGIN;
      const H = layout.height + 2 * MARGIN;
      return {
        W, H,
        text: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="${-MARGIN} ${-MARGIN} ${W} ${H}"><style>${css}</style>${markup(true)}</svg>\n`,
      };
    }
    const fileBase = () => tabTitle(d).replace(/[^\w.-]+/g, '_') || 'diagram';
    async function exportSvg(file) {
      if (!layout) return null;
      const target = file || await ide.api.invoke('diagrams:savePath', 'svg', `${fileBase()}.svg`);
      if (!target) return null;
      await ide.api.invoke('diagrams:write', target, 'svg', exportMarkup().text);
      return { file: target };
    }
    async function exportPng(file) {
      if (!layout) return null;
      const target = file || await ide.api.invoke('diagrams:savePath', 'png', `${fileBase()}.png`);
      if (!target) return null;
      const { W, H, text } = exportMarkup();
      // Twice the size for sharp text, within what a canvas can hold.
      const scale = Math.max(0.1, Math.min(2, 16000 / Math.max(W, H), Math.sqrt(120e6 / (W * H))));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The diagram could not be drawn')); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`; });
      const c = document.createElement('canvas');
      c.width = Math.ceil(W * scale);
      c.height = Math.ceil(H * scale);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/png').split(',')[1];
      await ide.api.invoke('diagrams:write', target, 'png', data);
      return { file: target, width: c.width, height: c.height };
    }

    // A tab is mounted before it is shown: fit once the canvas has a size.
    ide.util.observeSize(canvas, () => { if (!d.fitted && canvas.clientWidth && layout) { d.fitted = true; fit(); } });

    Object.assign(d, { select, removeClass, addClass, openClass, fit, setScale, zoomBy, reveal, exportSvg, exportPng, host, canvas, svg });
    d.dispose = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
    };
    relayout();
  }

  // ---------- entry points ----------
  const projectScope = (path) => (ide.root && isUnder(path, ide.root) ? [ide.root] : [ide.util.dirname(path)]);
  function showPaths(paths) {
    const p = paths[0];
    return openDiagram({ scope: paths, key: `scope:${p.toLowerCase()}` });
  }
  // The class at the line (and its relatives), or the whole file when the line is in no class.
  async function showAt(path, line) {
    const scope = projectScope(path);
    return openDiagram({ scope, focusPath: path, focusLine: line });
  }
  function showDiagram() {
    const ed = ide.editor;
    const model = ed?.getModel();
    const active = ide.activeTab?.();
    if (ed?.hasTextFocus() && active?.kind === 'file' && isPy(active.path) && model) return showAt(active.path, ed.getPosition().lineNumber);
    const treeFocused = document.activeElement?.closest?.('#tree');
    const entry = treeFocused ? ide.selectedTreeEntry?.() : null;
    if (entry && (entry.dir || isPy(entry.path))) return showPaths([entry.path]);
    if (active?.kind === 'file' && isPy(active.path)) return showPaths([active.path]);
    return ide.root ? showPaths([ide.root]) : null;
  }

  ide.registerAction({ id: 'ShowUmlDiagram', title: tr('Show Diagram'), keys: 'Ctrl+Alt+Shift+U', when: () => !!ide.root, run: showDiagram });
  ide.registerTreeAction({
    title: tr('Show Diagram'),
    keyAction: 'ShowUmlDiagram',
    when: (entry) => !!ide.root && (entry.dir || isPy(entry.path)),
    run: (entry) => showPaths([entry.path]),
  });
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.showUmlDiagram', label: tr('Show Diagram'), contextMenuGroupId: 'navigation', contextMenuOrder: 5,
    precondition: 'editorLangId == python',
    run: () => {
      const m = ed.getModel();
      const path = ide.tabs.find((t) => t.kind === 'file' && t.model === m)?.path;
      if (path) showAt(path, ed.getPosition().lineNumber);
    },
  }));

  // Saved Python files under a diagram's scope refresh it.
  let pending = null;
  const touched = new Set();
  const onChange = (paths) => {
    for (const p of paths) if (isPy(p)) touched.add(p);
    if (!touched.size || !diagrams.size) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      const list = [...touched];
      touched.clear();
      for (const d of diagrams.values()) {
        const scope = d.projectLoaded ? [ide.root] : d.scope;
        if (list.some((p) => scope.some((s) => isUnder(p, s)))) refresh(d);
      }
    }, 600);
  };
  ide.on('fileSaved', (tab) => tab?.path && onChange([tab.path]));
  ide.on('filesChanged', (c) => onChange([...(c?.created || []), ...(c?.deleted || []), ...(c?.renamed || []).flatMap((r) => (typeof r === 'string' ? [r] : [r.from, r.to]))].filter(Boolean)));

  // ---------- API (also used by verify/diagrams.mjs) ----------
  const current = (tabId) => diagrams.get(tabId || ide.activeTab?.()?.path) || null;
  const api = {
    slowMs: 0,
    showPaths, showAt, show: showDiagram, layout: layoutGraph, measure: boxOf,
    get: current,
    state(tabId) {
      const d = current(tabId);
      if (!d?.layout) return null;
      return {
        tabId: d.tabId, opts: { ...d.opts }, view: { ...d.view }, selected: d.selected, stats: d.stats, timing: d.timing,
        width: d.layout.width, height: d.layout.height,
        classes: [...d.layout.pos].map(([id, p]) => {
          const c = d.model.classes.get(id);
          return { id, name: c.name, qualname: c.qualname, module: c.module, stereotype: c.stereotype, inScope: c.inScope, ...p };
        }),
        edges: d.layout.routes.map((r) => ({ from: d.model.classes.get(r.from).qualname, to: d.model.classes.get(r.to).qualname, kind: r.kind, label: r.label || '', many: !!r.many, points: r.points })),
      };
    },
    exportSvg: (file, tabId) => current(tabId)?.exportSvg(file),
    exportPng: (file, tabId) => current(tabId)?.exportPng(file),
    addClass: (id, tabId) => current(tabId)?.addClass(id),
    findClass: (qualname, tabId) => [...(current(tabId)?.model.classes.values() || [])].find((c) => c.qualname === qualname)?.id || null,
  };
  ide.diagrams = api;
})();
