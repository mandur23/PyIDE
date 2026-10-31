// The *.pyflow graph: parsing, deterministic serialization and pure edit helpers. Every helper returns a new graph
// and leaves its input untouched, so the editor can keep old graphs for undo and compare by identity.
// graph: {format: 1, nodes: [{id, type, x, y, props?, inputs?, ...rest}], links: [{from: {node, pin}, to: {node, pin}}]}
(function (root) {
  'use strict';
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});

  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
  VS.tr = (text, vars) => (typeof root.tr === 'function' ? root.tr(text, vars) : fill(text, vars));
  const tr = VS.tr;

  VS.FORMAT = 1;
  VS.lastError = null;

  // pinsOf(node) needs the graph for pins that depend on other nodes (a Call Function's parameters). Callers that
  // only hold the node get the newest graph this module produced that contains it.
  const owners = new WeakMap();
  const track = (g) => {
    for (const n of g.nodes) owners.set(n, g);
    return g;
  };
  VS.ownerGraph = (node) => owners.get(node) || null;

  const idNumber = (id) => {
    const m = /^n(\d+)$/.exec(id);
    return m ? Number(m[1]) : Infinity;
  };
  const byId = (a, b) => idNumber(a) - idNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
  VS.compareIds = byId;

  VS.newGraph = () => track({ format: VS.FORMAT, nodes: [{ id: 'n1', type: 'core.start', x: 80, y: 120 }], links: [] });

  VS.nextId = (g) => {
    let max = 0;
    for (const n of g.nodes) {
      const k = idNumber(n.id);
      if (k !== Infinity && k > max) max = k;
    }
    return `n${max + 1}`;
  };

  // ---------- parse ----------
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // JSON.parse's messages differ between engines and often leave out the position, so a text that failed to parse
  // is scanned again to find where it went wrong.
  function jsonErrorAt(text) {
    let i = 0;
    const fail = () => {
      throw i;
    };
    const ws = () => {
      while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
    };
    const string = () => {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] < ' ') fail();
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i >= text.length) fail();
      i++;
    };
    const items = (close, item) => {
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        item();
        ws();
        if (text[i] === close) {
          i++;
          return;
        }
        if (text[i] !== ',') fail();
        i++;
      }
    };
    const value = () => {
      ws();
      if (text[i] === '{') {
        return items('}', () => {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ':') fail();
          i++;
          value();
        });
      }
      if (text[i] === '[') return items(']', value);
      if (text[i] === '"') return string();
      const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
      literal.lastIndex = i;
      const m = literal.exec(text);
      if (!m) fail();
      i += m[0].length;
    };
    try {
      value();
      ws();
      if (i < text.length) fail();
      return -1;
    } catch (pos) {
      return pos;
    }
  }

  function jsonError(text, err) {
    const pos = jsonErrorAt(text);
    if (pos < 0) return new Error(tr('The file is not valid JSON: {message}', { message: err.message }));
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    const message = pos >= text.length ? tr('the file ends too early') : tr('unexpected "{char}"', { char: text[pos] });
    return new Error(tr('The file is not valid JSON (line {line}, column {col}): {message}', { line, col, message }));
  }

  VS.parse = (text) => {
    if (typeof text !== 'string' || !text.trim()) return VS.newGraph();
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      throw jsonError(text, err);
    }
    const bad = (message, vars) => new Error(tr(message, vars));
    if (!isObj(data)) throw bad('A visual script file must contain a JSON object.');
    if (typeof data.format !== 'number') throw bad('The file has no "format" number.');
    if (data.format > VS.FORMAT) throw bad('This file was made by a newer Nano Studio (format {format}). Update Nano Studio to open it.', { format: data.format });
    if (data.format !== VS.FORMAT) throw bad('Unknown file format {format}.', { format: data.format });
    if (!Array.isArray(data.nodes)) throw bad('"nodes" must be a list.');
    if (data.links !== undefined && !Array.isArray(data.links)) throw bad('"links" must be a list.');
    const ids = new Set();
    const nodes = data.nodes.map((n, i) => {
      if (!isObj(n)) throw bad('Node {index} is not an object.', { index: i + 1 });
      if (typeof n.id !== 'string' || !n.id) throw bad('Node {index} has no "id".', { index: i + 1 });
      // The generated code names its locals after node ids (answer_n3), so an id is never anything but a name part.
      if (!/^[A-Za-z0-9_]+$/.test(n.id)) throw bad('Node {index} has the id "{id}". An id can contain only the letters A-Z and a-z, digits and _.', { index: i + 1, id: n.id });
      if (ids.has(n.id)) throw bad('Two nodes have the id "{id}".', { id: n.id });
      ids.add(n.id);
      if (typeof n.type !== 'string' || !n.type) throw bad('Node "{id}" has no "type".', { id: n.id });
      for (const k of ['x', 'y']) {
        if (n[k] !== undefined && !Number.isFinite(n[k])) throw bad('Node "{id}" has a "{key}" that is not a number.', { id: n.id, key: k });
      }
      for (const k of ['props', 'inputs']) {
        if (n[k] !== undefined && !isObj(n[k])) throw bad('Node "{id}" has "{key}" that is not an object.', { id: n.id, key: k });
      }
      return { ...n, x: Math.round(n.x || 0), y: Math.round(n.y || 0) };
    });
    const end = (l, i, side) => {
      const e = l[side];
      if (!isObj(e) || typeof e.node !== 'string' || typeof e.pin !== 'string') {
        throw bad('Wire {index} has no valid "{side}" (it needs a node and a pin).', { index: i + 1, side });
      }
      if (!ids.has(e.node)) throw bad('Wire {index} goes to a node that does not exist ("{id}").', { index: i + 1, id: e.node });
      return { node: e.node, pin: e.pin };
    };
    const links = (data.links || []).map((l, i) => {
      if (!isObj(l)) throw bad('Wire {index} is not an object.', { index: i + 1 });
      return { ...l, from: end(l, i, 'from'), to: end(l, i, 'to') };
    });
    return track({ ...data, nodes, links });
  };

  // ---------- serialize ----------
  const sortedKeys = (o) => Object.keys(o).sort();
  const pick = (o, keys) => {
    const out = {};
    for (const k of keys) out[k] = o[k];
    return out;
  };
  const sameLink = (a, b) => a.from.node === b.from.node && a.from.pin === b.from.pin && a.to.node === b.to.node && a.to.pin === b.to.pin;
  const linkKey = (l) => [l.from.node, l.from.pin, l.to.node, l.to.pin];
  const compareLinks = (a, b) => {
    const ka = linkKey(a);
    const kb = linkKey(b);
    for (let i = 0; i < 4; i++) {
      const c = i % 2 === 0 ? byId(ka[i], kb[i]) : ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
      if (c) return c;
    }
    return 0;
  };

  // Values equal to the node type's defaults are left out of the file.
  function compact(values, defaults) {
    const out = {};
    for (const k of sortedKeys(values || {})) {
      const v = values[k];
      if (v === undefined) continue;
      if (k in defaults && defaults[k] === v) continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function serializeNode(n, g) {
    const def = VS.nodeType ? VS.nodeType(n.type) : null;
    const propDefaults = {};
    const inputDefaults = {};
    if (def) {
      for (const p of def.props || []) propDefaults[p.id] = p.default;
      for (const p of VS.pinsOf(n, g).inputs) if ('default' in p) inputDefaults[p.id] = p.default;
    }
    const out = { id: n.id, type: n.type, x: Math.round(n.x || 0), y: Math.round(n.y || 0) };
    const props = compact(n.props, propDefaults);
    if (props) out.props = props;
    const inputs = compact(n.inputs, inputDefaults);
    if (inputs) out.inputs = inputs;
    const known = new Set(['id', 'type', 'x', 'y', 'props', 'inputs']);
    for (const k of sortedKeys(n)) if (!known.has(k) && n[k] !== undefined) out[k] = n[k];
    return out;
  }

  VS.serialize = (g) => {
    const nodes = [...g.nodes].sort((a, b) => byId(a.id, b.id)).map((n) => serializeNode(n, g));
    const links = [...g.links].sort(compareLinks).map((l) => {
      const out = { from: pick(l.from, ['node', 'pin']), to: pick(l.to, ['node', 'pin']) };
      for (const k of sortedKeys(l)) if (k !== 'from' && k !== 'to' && l[k] !== undefined) out[k] = l[k];
      return out;
    });
    const out = { format: g.format || VS.FORMAT, nodes, links };
    for (const k of sortedKeys(g)) if (!(k in out) && g[k] !== undefined) out[k] = g[k];
    return `${JSON.stringify(out, null, 2)}\n`;
  };

  // ---------- pins and wires ----------
  VS.compatible = (fromType, toType) => {
    if (fromType === 'exec' || toType === 'exec') return fromType === toType;
    return fromType === toType || fromType === 'any' || toType === 'any' || (fromType === 'int' && toType === 'number');
  };

  // -> {node, pin, dir: 'in'|'out', kind: 'exec'|'data', type, label} or null
  VS.findPin = (g, end) => {
    const node = g.nodes.find((n) => n.id === end.node);
    if (!node || !VS.pinsOf || !VS.nodeType(node.type)) return null;
    const pins = VS.pinsOf(node, g);
    if (end.pin === 'in' && pins.execIn) return { node, pin: 'in', dir: 'in', kind: 'exec', type: 'exec', label: '' };
    const eo = pins.execOut.find((p) => p.id === end.pin);
    if (eo) return { node, pin: eo.id, dir: 'out', kind: 'exec', type: 'exec', label: eo.label };
    const di = pins.inputs.find((p) => p.id === end.pin);
    if (di) return { node, pin: di.id, dir: 'in', kind: 'data', type: di.type, label: di.label };
    const dout = pins.outputs.find((p) => p.id === end.pin);
    if (dout) return { node, pin: dout.id, dir: 'out', kind: 'data', type: dout.type, label: dout.label };
    return null;
  };

  // Is `target` reachable from `start` by following wires of one kind forwards?
  function reaches(g, start, target, kind) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of g.links) {
        if (l.from.node !== id) continue;
        const p = VS.findPin(g, l.from);
        if (p && p.kind === kind) stack.push(l.to.node);
      }
    }
    return false;
  }

  // Keeps only wires whose two pins still exist (a Format Text template or a function's parameters changed).
  function pruneLinks(g) {
    const links = g.links.filter((l) => {
      const a = VS.findPin(g, l.from);
      const b = VS.findPin(g, l.to);
      const unknown = (end) => !VS.nodeType(g.nodes.find((n) => n.id === end.node).type);
      return (a || unknown(l.from)) && (b || unknown(l.to));
    });
    return links.length === g.links.length ? g : { ...g, links };
  }

  // ---------- edit helpers ----------
  const replaceNode = (g, id, fn) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? fn(n) : n)) });

  VS.addNode = (g, node) => {
    const n = { x: 0, y: 0, ...node, id: node.id && !g.nodes.some((m) => m.id === node.id) ? node.id : VS.nextId(g) };
    n.x = Math.round(n.x);
    n.y = Math.round(n.y);
    return track({ ...g, nodes: [...g.nodes, n] });
  };

  VS.removeNodes = (g, ids) => {
    const gone = new Set(ids);
    return track({
      ...g,
      nodes: g.nodes.filter((n) => !gone.has(n.id)),
      links: g.links.filter((l) => !gone.has(l.from.node) && !gone.has(l.to.node)),
    });
  };

  VS.moveNodes = (g, ids, dx, dy) => {
    const moving = new Set(ids);
    return track({
      ...g,
      nodes: g.nodes.map((n) => (moving.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)),
    });
  };

  // Renaming a Define Function renames the Call Function nodes that called it, as Blueprint does.
  VS.setProp = (g, id, key, value) => {
    const node = g.nodes.find((n) => n.id === id);
    if (!node) return g;
    const props = { ...(node.props || {}) };
    if (value === undefined) delete props[key];
    else props[key] = value;
    let next = replaceNode(g, id, (n) => ({ ...n, props }));
    if (node.type === 'fn.define' && key === 'name') {
      const old = VS.propOf(node, 'name');
      next = {
        ...next,
        nodes: next.nodes.map((n) => (n.type === 'fn.call' && VS.propOf(n, 'function') === old
          ? { ...n, props: { ...(n.props || {}), function: value } } : n)),
      };
    }
    return track(pruneLinks(next));
  };

  VS.setInputLiteral = (g, id, pin, value) => {
    if (!g.nodes.some((n) => n.id === id)) return g;
    return track(replaceNode(g, id, (n) => {
      const inputs = { ...(n.inputs || {}) };
      if (value === undefined) delete inputs[pin];
      else inputs[pin] = value;
      const out = { ...n, inputs };
      if (!Object.keys(inputs).length) delete out.inputs;
      return out;
    }));
  };

  const refuse = (g, message, vars) => {
    VS.lastError = tr(message, vars);
    return g;
  };

  // from/to may be given in either direction. A data input and an exec output keep one wire: the new one wins.
  VS.connect = (g, from, to) => {
    VS.lastError = null;
    let a = VS.findPin(g, from);
    let b = VS.findPin(g, to);
    if (!a || !b) return refuse(g, 'That pin does not exist.');
    if (a.dir === 'in' && b.dir === 'out') [a, b] = [b, a];
    if (a.dir !== 'out' || b.dir !== 'in') return refuse(g, 'Connect an output pin to an input pin.');
    if (a.kind !== b.kind) return refuse(g, 'Run-order (white) pins connect only to run-order pins.');
    if (a.node.id === b.node.id) return refuse(g, 'A node cannot be connected to itself.');
    if (!VS.compatible(a.type, b.type)) {
      return refuse(g, 'A {from} value cannot go into a {to} input.', { from: VS.typeLabel(a.type), to: VS.typeLabel(b.type) });
    }
    if (reaches(g, b.node.id, a.node.id, a.kind)) {
      return refuse(g, a.kind === 'exec'
        ? 'Run-order wires cannot go in a circle. Use a While or For loop to repeat steps.'
        : 'This wire would make a value depend on itself.');
    }
    const link = { from: { node: a.node.id, pin: a.pin }, to: { node: b.node.id, pin: b.pin } };
    if (g.links.some((l) => sameLink(l, link))) return g;
    const links = g.links.filter((l) => {
      if (a.kind === 'data') return !(l.to.node === link.to.node && l.to.pin === link.to.pin);
      return !(l.from.node === link.from.node && l.from.pin === link.from.pin);
    });
    return track({ ...g, links: [...links, link] });
  };

  VS.disconnect = (g, link) => {
    const links = g.links.filter((l) => !sameLink(l, link));
    return links.length === g.links.length ? g : track({ ...g, links });
  };

  // Removes every wire on a node, or on one of its pins.
  VS.disconnectAll = (g, id, pin) => {
    const hit = (e) => e.node === id && (pin === undefined || e.pin === pin);
    const links = g.links.filter((l) => !hit(l.from) && !hit(l.to));
    return links.length === g.links.length ? g : track({ ...g, links });
  };

  // Copies nodes with fresh ids; wires between copied nodes are copied too. A Start node is not copied into a graph
  // that already has one, since a script has exactly one.
  function insert(g, nodes, links, place) {
    const hasStart = g.nodes.some((n) => n.type === 'core.start');
    const ids = [];
    const rename = new Map();
    let next = idNumber(VS.nextId(g));
    const added = [];
    for (const n of [...nodes].sort((a, b) => byId(a.id, b.id))) {
      if (n.type === 'core.start' && (hasStart || added.some((m) => m.type === 'core.start'))) continue;
      const id = `n${next++}`;
      rename.set(n.id, id);
      ids.push(id);
      const copy = JSON.parse(JSON.stringify(n));
      const [x, y] = place(n);
      added.push({ ...copy, id, x: Math.round(x), y: Math.round(y) });
    }
    const newLinks = links
      .filter((l) => rename.has(l.from.node) && rename.has(l.to.node))
      .map((l) => ({ from: { node: rename.get(l.from.node), pin: l.from.pin }, to: { node: rename.get(l.to.node), pin: l.to.pin } }));
    return { graph: track({ ...g, nodes: [...g.nodes, ...added], links: [...g.links, ...newLinks] }), ids };
  }

  VS.duplicate = (g, ids, dx = 32, dy = 32) => {
    const chosen = new Set(ids);
    const nodes = g.nodes.filter((n) => chosen.has(n.id));
    return insert(g, nodes, g.links, (n) => [n.x + dx, n.y + dy]);
  };

  // (x, y) is where the top-left corner of the pasted nodes goes; without it they land 32 units right and down.
  VS.pasteNodes = (g, nodes, links = [], x, y) => {
    const valid = (nodes || []).filter((n) => isObj(n) && typeof n.id === 'string' && typeof n.type === 'string');
    const okLinks = (links || []).filter((l) => isObj(l) && isObj(l.from) && isObj(l.to));
    const hasStart = g.nodes.some((n) => n.type === 'core.start');
    const placed = valid.filter((n) => !(hasStart && n.type === 'core.start'));
    if (!placed.length) return { graph: g, ids: [] };
    const minX = Math.min(...placed.map((n) => n.x || 0));
    const minY = Math.min(...placed.map((n) => n.y || 0));
    const at = Number.isFinite(x) && Number.isFinite(y);
    return insert(g, placed, okLinks, (n) => (at ? [(n.x || 0) - minX + x, (n.y || 0) - minY + y] : [(n.x || 0) + 32, (n.y || 0) + 32]));
  };

  if (typeof module === 'object' && module.exports) module.exports = VS;
})(typeof window !== 'undefined' ? window : globalThis);
