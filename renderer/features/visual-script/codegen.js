// Turns a graph into readable Python. Exec nodes become one statement each, following the run-order wires from
// Start (under `def main():`) and from each Define Function; pure nodes are inlined as expressions with only the
// parentheses Python needs. `map[line]` is the node that produced each generated line, so a traceback finds its node.
// VS.compile(graph, {fileName, tr, symbols}) -> {code, map, errors, pinExpr, nodeLines}; `symbols` (default VS.symbols)
// tells project and package nodes whether their function still exists.
//
// Set Variable names are script variables, as Blueprint's graph variables are: every function that sets one declares
// it `global`, and any function reads it. A value wired from a step (a generated local such as answer_n3, a loop
// index, a function parameter) is only usable where that step has always run before, in the same function.
//
// The context `c` a node's compile hook gets:
//   c.node, c.pins, c.P (precedences), c.tr, c.inLoop, c.inFunction
//   c.prop(key), c.input(pin) -> {code, prec, type, literal, value}, c.arg(pin, minPrec = 0) -> code
//   c.linked(pin), c.execLinked(pin), c.used(outPin), c.local(outPin)
//   c.line(text), c.rawLine(text) (no indent added), c.block(execPin, {loop, fn}), c.fail(message, prop) -> null
//   c.ident(prop), c.identValue(value, prop), c.variable(prop), c.assign(name), c.dotted(name), c.functionExists(name)
//   c.literal(value, type), c.formatText(template), c.pythonExpression(code, names), c.import(module)
//   c.dedent(code) -> [{text, raw}] (raw: the line starts inside a string, so it is kept exactly)
//   c.symbol(module, name) -> the name to call it by (its import added), c.symbols, c.warn(message)
(function (root) {
  'use strict';
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});

  const P = { TUPLE: -1, LOW: 0, OR: 1, AND: 2, NOT: 3, CMP: 4, BOR: 5, BXOR: 6, BAND: 7, SHIFT: 8, ADD: 9, MUL: 10, UNARY: 11, POW: 12, ATOM: 14 };
  VS.PREC = P;

  const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
  // Names the generated code itself calls; a variable or function with one of them would break it.
  const BUILTINS_USED = ['print', 'input', 'str', 'int', 'float', 'len', 'range', 'RuntimeError', 'main'];
  const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
  const IDENT = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u;
  VS.isIdentifier = (s) => typeof s === 'string' && IDENT.test(s) && !KEYWORDS.has(s);

  // ---------- Python literals ----------
  const pyStr = (s) => {
    const quote = s.includes('"') && !s.includes("'") ? "'" : '"';
    let out = '';
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === quote) out += `\\${quote}`;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
    return quote + out + quote;
  };
  VS.pyString = pyStr;

  const pyNumber = (n) => {
    if (Number.isNaN(n)) return { code: 'float("nan")', prec: P.ATOM };
    if (!Number.isFinite(n)) return { code: n > 0 ? 'float("inf")' : '-float("inf")', prec: n > 0 ? P.ATOM : P.UNARY };
    const code = Object.is(n, -0) ? '0' : String(n);
    return { code, prec: n < 0 ? P.UNARY : P.ATOM };
  };

  // ---------- a small Python tokenizer (enough to find names, strings and top-level operators) ----------
  const OPS = ['**=', '//=', '>>=', '<<=', '...', '**', '//', '==', '!=', '<=', '>=', '->', ':=', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='];
  function tokenize(code) {
    const toks = [];
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (/\s/.test(ch)) {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        toks.push({ kind: 'space', text: code.slice(i, j) });
        i = j;
        continue;
      }
      if (ch === '#') {
        let j = code.indexOf('\n', i);
        if (j < 0) j = code.length;
        toks.push({ kind: 'comment', text: code.slice(i, j) });
        i = j;
        continue;
      }
      NAME.lastIndex = i;
      const name = NAME.exec(code);
      let prefix = '';
      if (name) {
        const after = code[i + name[0].length];
        if (/^[rRbBuUfF]{1,2}$/.test(name[0]) && (after === '"' || after === "'")) prefix = name[0];
        else {
          toks.push({ kind: 'name', text: name[0] });
          i += name[0].length;
          continue;
        }
      }
      const q = code[i + prefix.length];
      if (q === '"' || q === "'") {
        const start = i;
        const triple = code.startsWith(q.repeat(3), i + prefix.length);
        const delim = triple ? q.repeat(3) : q;
        let j = i + prefix.length + delim.length;
        while (j < code.length && !code.startsWith(delim, j)) {
          if (code[j] === '\\') j++;
          else if (!triple && code[j] === '\n') break;
          j++;
        }
        j = Math.min(code.length, j + delim.length);
        toks.push({ kind: 'string', text: code.slice(start, j), prefix });
        i = j;
        continue;
      }
      const num = /(?:\d|\.\d)(?:[eE][+-]\d|[\w.])*/y;
      num.lastIndex = i;
      const m = num.exec(code);
      if (m) {
        toks.push({ kind: 'number', text: m[0] });
        i += m[0].length;
        continue;
      }
      const op = OPS.find((o) => code.startsWith(o, i)) || ch;
      toks.push({ kind: 'op', text: op });
      i += op.length;
    }
    return toks;
  }

  const BIN_PREC = { '|': P.BOR, '^': P.BXOR, '&': P.BAND, '<<': P.SHIFT, '>>': P.SHIFT, '+': P.ADD, '-': P.ADD,
    '*': P.MUL, '/': P.MUL, '//': P.MUL, '%': P.MUL, '@': P.MUL, '**': P.POW,
    '==': P.CMP, '!=': P.CMP, '<': P.CMP, '<=': P.CMP, '>': P.CMP, '>=': P.CMP };
  const WORD_PREC = { or: P.OR, and: P.AND, not: P.NOT, in: P.CMP, is: P.CMP, if: P.LOW, lambda: P.LOW, for: P.TUPLE, yield: P.TUPLE };

  // The loosest operator at the top level of an expression decides where it needs parentheses.
  function expressionPrec(toks) {
    let depth = 0;
    let prec = P.ATOM;
    let prev = null;
    for (const t of toks) {
      if (t.kind === 'space' || t.kind === 'comment') continue;
      if (t.kind === 'op' && '([{'.includes(t.text)) depth++;
      else if (t.kind === 'op' && ')]}'.includes(t.text)) depth--;
      else if (depth === 0) {
        let p = null;
        if (t.kind === 'op' && (t.text === ',' || t.text === ':=')) p = P.TUPLE;
        else if (t.kind === 'op' && t.text === '*' && !prev) p = P.TUPLE;
        else if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '~')) {
          p = prev && (prev.kind !== 'op' || ')]}'.includes(prev.text)) ? P.ADD : P.UNARY;
        } else if (t.kind === 'op' && t.text in BIN_PREC) p = BIN_PREC[t.text];
        else if (t.kind === 'name' && t.text in WORD_PREC) p = t.text === 'not' && prev && prev.kind === 'name' && prev.text !== 'not' && !(prev.text in WORD_PREC) ? P.CMP : WORD_PREC[t.text];
        if (p !== null && p < prec) prec = p;
      }
      prev = t;
    }
    return prec;
  }

  // Lines (0-based) of `code` that start inside a string: a triple-quoted string's later lines, a line continued with \.
  function stringLines(code) {
    const inside = new Set();
    let line = 0;
    for (const t of tokenize(code)) {
      for (const ch of t.text) {
        if (ch !== '\n') continue;
        line++;
        if (t.kind === 'string') inside.add(line);
      }
    }
    return inside;
  }

  // A string token that ends with its own closing quote(s).
  function closedString(t) {
    const body = t.text.slice(t.prefix.length);
    const q = body[0];
    const delim = body.startsWith(q.repeat(3)) && body.length >= 6 ? q.repeat(3) : q;
    for (let i = delim.length; i < body.length; i++) {
      if (body[i] === '\\') i++;
      else if (body.startsWith(delim, i)) return i + delim.length === body.length;
    }
    return false;
  }
  const PY_NUMBER = /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)$/;
  const PAIRS = { ')': '(', ']': '[', '}': '{' };
  // One Python literal on one line: numbers, strings (not f-strings), True, False, None, ... and lists, tuples, sets and
  // dicts of them. No name other than those three can appear, so nothing in it can call or import anything.
  VS.isPythonLiteral = (text) => {
    const s = String(text ?? '');
    if (!s.trim() || /[\r\n]/.test(s)) return false;
    const open = [];
    for (const t of tokenize(s)) {
      if (t.kind === 'space') continue;
      if (t.kind === 'name') { if (!['True', 'False', 'None'].includes(t.text)) return false; continue; }
      if (t.kind === 'number') { if (!PY_NUMBER.test(t.text)) return false; continue; }
      if (t.kind === 'string') { if (/f/i.test(t.prefix) || !closedString(t)) return false; continue; }
      if (t.kind !== 'op') return false;
      if ('([{'.includes(t.text)) open.push(t.text);
      else if (t.text in PAIRS) { if (open.pop() !== PAIRS[t.text]) return false; }
      else if (t.text === ',') { if (!open.length) return false; }
      else if (t.text === ':') { if (open[open.length - 1] !== '{') return false; }
      else if (!['-', '+', '...'].includes(t.text)) return false;
    }
    return !open.length;
  };

  const wrap = (e, min) => (e.prec < min ? `(${e.code})` : e.code);

  VS.hasErrors = (result) => result.errors.some((e) => !e.warning);

  // ---------- compile ----------
  VS.compile = (graph, opts = {}) => {
    const tr = (text, vars) => (opts.tr || VS.tr)(text, vars);
    const fileName = String(opts.fileName || 'script.pyflow').replace(/[\r\n]+/g, ' ');
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const sorted = [...graph.nodes].sort((a, b) => VS.compareIds(a.id, b.id));
    const defOf = (n) => VS.nodeType(n.type);
    const pinsCache = new Map();
    const pinsOf = (n) => {
      if (!pinsCache.has(n.id)) pinsCache.set(n.id, VS.pinsOf(n, graph));
      return pinsCache.get(n.id);
    };
    const key = (id, pin) => `${id}\u0000${pin}`;
    const isStatement = (n) => { const d = defOf(n); return !!d && !!d.compile && !!d.compile.stmt; };
    const isPure = (n) => { const d = defOf(n); return !!d && !!d.compile && !!d.compile.expr; };

    const errors = [];
    const reported = new Set();
    let silent = false; // while pinExpr compiles pure nodes again, their problems are already known
    const report = (node, message, extra = {}) => {
      if (silent) return;
      const k = `${node}\u0000${extra.pin || ''}\u0000${extra.prop || ''}\u0000${message}`;
      if (reported.has(k)) return;
      reported.add(k);
      const e = { node: node || null, message };
      if (extra.pin) e.pin = extra.pin;
      if (extra.prop) e.prop = extra.prop;
      if (extra.warning) e.warning = true;
      errors.push(e);
    };

    for (const n of sorted) if (!defOf(n)) report(n.id, tr('Unknown node type "{type}".', { type: n.type }));

    // ---------- wires ----------
    const dataIn = new Map();
    const execNext = new Map();
    const usedOut = new Set();
    const dataEdges = new Map();
    const links = [...graph.links].sort((a, b) => VS.compareIds(a.from.node, b.from.node)
      || (a.from.pin < b.from.pin ? -1 : a.from.pin > b.from.pin ? 1 : 0)
      || VS.compareIds(a.to.node, b.to.node) || (a.to.pin < b.to.pin ? -1 : a.to.pin > b.to.pin ? 1 : 0));
    for (const l of links) {
      const from = nodes.get(l.from.node);
      const to = nodes.get(l.to.node);
      if (!from || !to || !defOf(from) || !defOf(to)) continue;
      const a = VS.findPin(graph, l.from);
      const b = VS.findPin(graph, l.to);
      if (!a || !b) {
        report(to.id, tr('A wire is connected to a pin that no longer exists. Delete the wire.'), { pin: l.to.pin });
        continue;
      }
      if (a.dir !== 'out' || b.dir !== 'in' || a.kind !== b.kind) {
        report(to.id, tr('This wire joins two pins that cannot be connected.'), { pin: l.to.pin });
        continue;
      }
      if (a.kind === 'data' && !VS.compatible(a.type, b.type)) {
        report(to.id, tr('A {from} value cannot go into a {to} input.', { from: VS.typeLabel(a.type), to: VS.typeLabel(b.type) }), { pin: l.to.pin });
        continue;
      }
      if (a.kind === 'data') {
        if (dataIn.has(key(to.id, b.pin))) {
          report(to.id, tr('This input has more than one wire.'), { pin: b.pin });
          continue;
        }
        dataIn.set(key(to.id, b.pin), { node: from.id, pin: a.pin, type: a.type });
        usedOut.add(key(from.id, a.pin));
        if (!dataEdges.has(from.id)) dataEdges.set(from.id, new Set());
        dataEdges.get(from.id).add(to.id);
      } else {
        if (execNext.has(key(from.id, a.pin))) {
          report(from.id, tr('This run-order output has more than one wire.'), { pin: a.pin });
          continue;
        }
        execNext.set(key(from.id, a.pin), to.id);
      }
    }

    // A value that depends on itself can never be computed.
    {
      const state = new Map();
      const visit = (id, stack) => {
        state.set(id, 1);
        stack.push(id);
        for (const next of dataEdges.get(id) || []) {
          if (state.get(next) === 1) {
            for (const c of stack.slice(stack.indexOf(next))) report(c, tr('This value depends on itself: its wires go in a circle.'));
          } else if (!state.has(next)) visit(next, stack);
        }
        stack.pop();
        state.set(id, 2);
      };
      for (const n of sorted) if (!state.has(n.id)) visit(n.id, []);
    }

    // ---------- names ----------
    const starts = sorted.filter((n) => n.type === 'core.start');
    const defines = sorted.filter((n) => n.type === 'fn.define');
    const functions = new Map();
    for (const d of defines) {
      const name = VS.propOf(d, 'name');
      if (functions.has(name)) report(d.id, tr('Two functions are named "{name}".', { name }), { prop: 'name' });
      else functions.set(name, d);
    }
    const moduleRoots = new Set(sorted.filter((n) => n.type === 'py.call')
      .map((n) => String(VS.propOf(n, 'module') || '').trim().split('.')[0]).filter(Boolean));
    // Every name a node stores a value under: [node, prop, name].
    const named = [];
    for (const n of sorted) {
      if (n.type === 'var.set') named.push([n, 'name', VS.propOf(n, 'name')]);
      if (n.type === 'fn.define') VS.parseNames(VS.propOf(n, 'params')).forEach((p) => named.push([n, 'params', p]));
      if (n.type === 'py.code') ['inputs', 'outputs'].forEach((k) => VS.parseNames(VS.propOf(n, k)).forEach((p) => named.push([n, k, p])));
    }
    const variables = new Set(named.map(([, , name]) => name));
    const scriptVariables = new Set(named.filter(([n]) => n.type === 'var.set').map(([, , name]) => name));
    // Calling a function whose name a variable also holds would call the value (or fail before it is set).
    for (const [n, prop, name] of named) {
      if (functions.has(name)) report(n.id, tr('A function is also named "{name}". Give the variable or the function another name.', { name }), { prop });
    }
    for (const [name, d] of functions) {
      if (variables.has(name)) report(d.id, tr('A variable is also named "{name}". Give the variable or the function another name.', { name }), { prop: 'name' });
    }

    // Project and package symbols: `from geo.figures import area` and `area(2)`, unless two modules give the same
    // name or the name is taken by the script itself; then `import geo.figures` and `geo.figures.area(2)`.
    const symbols = opts.symbols !== undefined ? opts.symbols : VS.symbols;
    const symbolNodes = sorted.filter((n) => (VS.SYMBOL_TYPES || []).includes(n.type));
    const providers = new Map();
    for (const n of symbolNodes) {
      const p = n.props || {};
      const name = n.type === 'py.function' ? p.name : p.class;
      if (typeof name !== 'string' || typeof p.module !== 'string') continue;
      if (!providers.has(name)) providers.set(name, new Set());
      providers.get(name).add(p.module);
    }
    const usesAsync = symbolNodes.some((n) => n.type !== 'py.new' && n.props && n.props.async);
    const taken = new Set([...BUILTINS_USED, ...moduleRoots, ...variables, ...functions.keys(), ...(usesAsync ? ['asyncio'] : [])]);
    const symbolRefs = new Map(); // module \0 name -> {module, name, ref, from?, alias?}
    for (const [name, modules] of providers) {
      for (const module of modules) {
        const ref = { module, name };
        if (modules.size === 1 && !taken.has(name)) Object.assign(ref, { from: true, ref: name });
        else if (taken.has(module.split('.')[0])) {
          const alias = `${module.replace(/\./g, '_')}_module`;
          Object.assign(ref, { alias, ref: `${alias}.${name}` });
        }
        else ref.ref = `${module}.${name}`;
        symbolRefs.set(`${module}\u0000${name}`, ref);
      }
    }
    const reserved = new Set([...BUILTINS_USED, ...moduleRoots, ...(usesAsync ? ['asyncio'] : [])]);
    for (const r of symbolRefs.values()) reserved.add(r.from ? r.name : r.alias || r.module.split('.')[0]);

    if (!starts.length) report(null, tr('The script has no Start node. Add one to say where it begins.'));
    for (const s of starts.slice(1)) report(s.id, tr('A script can have only one Start node.'));

    // ---------- emission ----------
    let lines = [];
    let indent = 0;
    const emit = (text, node) => lines.push({ text: text ? '    '.repeat(indent) + text : '', node });
    const imports = new Map();
    const fromImports = new Map(); // module -> Map(name -> first node)
    const visited = new Set();
    const path = new Set();
    const evaluating = new Set();

    // Where each step was emitted: {fn: its entry node, path: [[block, index], ...]} from the function's body down to
    // the block it is in. `fn` is the entry being compiled: {id, assigned: names it stores, params}.
    const position = new Map();
    let fn = null;
    let openBlocks = []; // the blocks being emitted, outermost first: {id, n: steps so far, at: the step being compiled}
    let blockSeq = 0;
    const uses = []; // {stmt, pin, producer}: a step reads a value an earlier step (or its entry) made
    function enterBlock() {
      openBlocks.push({ id: ++blockSeq, n: 0, at: -1 });
    }
    function place(id) {
      const top = openBlocks[openBlocks.length - 1];
      position.set(id, { fn: fn.id, path: [...openBlocks.slice(0, -1).map((b) => [b.id, b.at]), [top.id, top.n]] });
      top.at = top.n++;
    }
    // Does `producer` always run before `stmt`? Steps run in their block's order; a loop's outputs exist only inside
    // its body; an entry's (its parameters) everywhere in its function.
    function runsBefore(producer, stmt) {
      const a = position.get(producer);
      const b = position.get(stmt);
      if (!a || !b || a.fn !== b.fn) return false;
      const k = a.path.length - 1;
      if (k < 0) return true;
      const s = b.path;
      if (s.length <= k || s[k][0] !== a.path[k][0]) return false;
      if (defOf(nodes.get(producer)).outputScope === 'body') return s[k][1] === a.path[k][1] && s.length > k + 1;
      return s[k][1] > a.path[k][1];
    }

    function context(node, scope, owner) {
      const def = defOf(node);
      const c = {
        node, P, tr,
        stmt: owner ? owner.stmt : node.id,
        via: null,
        pins: pinsOf(node),
        inLoop: !!scope.loop,
        inFunction: !!scope.fn,
        pending: owner ? owner.pending : [],
        prop: (k) => VS.propOf(node, k),
        linked: (pin) => dataIn.has(key(node.id, pin)),
        execLinked: (pin) => execNext.has(key(node.id, pin)),
        used: (pin) => usedOut.has(key(node.id, pin)),
        local: (pin) => `${pin}_${node.id}`,
        fail(message, prop) {
          report(node.id, message, prop ? { prop } : {});
          c.pending.push({ node: node.id, message });
          return null;
        },
        failPin(message, pin) {
          report(node.id, message, { pin });
          c.pending.push({ node: node.id, message });
        },
        line(text) {
          flush(c);
          emit(text, node.id);
        },
        rawLine(text) {
          flush(c);
          lines.push({ text, node: node.id });
        },
        block(pin, opts = {}) {
          flush(c);
          indent++;
          const before = lines.length;
          const target = execNext.get(key(node.id, pin));
          enterBlock();
          if (target) chain(target, { loop: scope.loop || opts.loop, fn: scope.fn || opts.fn });
          openBlocks.pop();
          if (lines.length === before) emit('pass', node.id);
          indent--;
        },
        assign(name) {
          if (fn) fn.assigned.add(name);
        },
        import(module) {
          if (!imports.has(module)) imports.set(module, node.id);
        },
        symbols,
        warn: (message) => report(node.id, message, { warning: true }),
        // The name that refers to `name` from `module` in the generated code; its import is added.
        symbol(module, name) {
          const r = symbolRefs.get(`${module}\u0000${name}`);
          if (r.from) {
            if (!fromImports.has(module)) fromImports.set(module, new Map());
            if (!fromImports.get(module).has(name)) fromImports.get(module).set(name, node.id);
          } else c.import(r.alias ? `${module} as ${r.alias}` : module);
          return r.ref;
        },
        dotted: (s) => typeof s === 'string' && s.split('.').every(VS.isIdentifier),
        functionExists: (name) => functions.has(name),
        identValue(value, prop) {
          const name = String(value ?? '').trim();
          let message = null;
          if (!name) message = tr('Enter a name.');
          else if (KEYWORDS.has(name)) message = tr('"{name}" is a Python keyword and cannot be used as a name.', { name });
          else if (!IDENT.test(name)) message = tr('"{name}" cannot be used as a name. Use letters, digits and _, and do not start with a digit.', { name });
          else if (reserved.has(name)) message = tr('"{name}" is already used by the generated code. Choose another name.', { name });
          if (!message) return name;
          c.fail(message, prop);
          // A replacement that stays valid Python, distinct for each name of a list prop ("a, 1b, 2c").
          const whole = String(c.prop(prop) ?? '').trim();
          return name === whole ? `${prop}_${node.id}` : `${prop}${VS.parseNames(whole).indexOf(name) + 1}_${node.id}`;
        },
        ident: (prop) => c.identValue(c.prop(prop), prop),
        variable(prop) {
          const name = c.ident(prop);
          if (name === `${prop}_${node.id}`) return name;
          if (!variables.has(name)) c.fail(tr('No Set Variable stores a value named "{name}".', { name }), prop);
          return name;
        },
        input(pin) {
          const src = dataIn.get(key(node.id, pin));
          const pinDef = c.pins.inputs.find((p) => p.id === pin);
          if (!src) {
            const v = node.inputs && node.inputs[pin] !== undefined ? node.inputs[pin] : pinDef && pinDef.default;
            if (v === undefined) {
              if (pinDef && !pinDef.optional) {
                c.failPin(tr('"{pin}" needs a value: connect a wire or type one in.', { pin: tr(pinDef.label) }), pin);
              }
              return { code: 'None', prec: P.ATOM, type: 'none', literal: true, value: undefined };
            }
            return { ...c.literal(v, pinDef ? pinDef.type : 'any', pin), literal: true, value: v };
          }
          const from = nodes.get(src.node);
          return { ...valueOf(from, src.pin, c, c.via ?? pin), type: src.type, literal: false };
        },
        arg: (pin, min = 0) => wrap(c.input(pin), min),
        literal(v, type, pin) {
          if (v === null) return { code: 'None', prec: P.ATOM, type: 'none' };
          if (typeof v === 'boolean') return { code: v ? 'True' : 'False', prec: P.ATOM, type: 'bool' };
          if (typeof v === 'string' && (type === 'number' || type === 'int')) {
            // An integer a double cannot hold exactly is kept as typed: Python's int has no limit.
            if (/^\s*[+-]?\d+\s*$/.test(v) && !Number.isSafeInteger(Number(v))) {
              const big = BigInt(v.trim());
              return { code: big.toString(), prec: big < 0n ? P.UNARY : P.ATOM, type: 'int' };
            }
            const n = v.trim() === '' ? NaN : Number(v);
            if (!Number.isFinite(n)) {
              const message = tr('"{value}" is not a number.', { value: v });
              if (pin) c.failPin(message, pin);
              else c.fail(message);
              return { code: 'None', prec: P.ATOM, type: 'none' };
            }
            v = n;
          }
          if (typeof v === 'number') return { ...pyNumber(v), type: Number.isInteger(v) ? 'int' : 'number' };
          if (Array.isArray(v)) return { code: `[${v.map((x) => c.literal(x, 'any').code).join(', ')}]`, prec: P.ATOM, type: 'list' };
          if (typeof v === 'object') {
            const items = Object.keys(v).map((k) => `${pyStr(k)}: ${c.literal(v[k], 'any').code}`);
            return { code: `{${items.join(', ')}}`, prec: P.ATOM, type: 'dict' };
          }
          return { code: pyStr(String(v)), prec: P.ATOM, type: 'string' };
        },
        formatText(template) {
          const t = VS.templateFields(template);
          // A spec like {name:{width}} would be a nested replacement field: code inside the f-string.
          const nested = t.parts.some((p) => typeof p !== 'string' && p.spec.includes('{'));
          if (t.error || nested) c.fail(tr('The template has a { or } without its partner. Write {{ or }} for a brace that should show.'), 'template');
          for (const f of t.fields) if (!VS.isIdentifier(f)) c.fail(tr('"{name}" in the template is not a valid name. Use names like {name_example}.', { name: f, name_example: '{name}' }), 'template');
          let body = '';
          let plain = '';
          let dynamic = false;
          let safe = true;
          for (const part of t.parts) {
            if (typeof part === 'string') {
              body += part.replace(/[{}]/g, '$&$&');
              plain += part;
              continue;
            }
            const inp = c.input(part.field);
            if (inp.literal && typeof inp.value === 'string' && !part.conv && !part.spec) {
              body += inp.value.replace(/[{}]/g, '$&$&');
              plain += inp.value;
              continue;
            }
            const code = wrap(inp, P.LOW);
            if (/['"\\{}#\n!:]/.test(code)) safe = false;
            dynamic = true;
            body += `{${code}${part.conv ? `!${part.conv}` : ''}${part.spec && !part.spec.includes('{') ? `:${part.spec}` : ''}}`;
          }
          if (!dynamic) return { code: pyStr(plain), prec: P.ATOM };
          if (safe) return { code: `f${pyStr(body)}`, prec: P.ATOM };
          const args = t.fields.filter(VS.isIdentifier).map((f) => `${f}=${c.arg(f)}`);
          return { code: `${pyStr(String(template))}.format(${args.join(', ')})`, prec: P.ATOM };
        },
        pythonExpression(code, names) {
          const src = String(code ?? '').trim();
          if (!src) {
            c.fail(tr('Enter a Python expression.'), 'code');
            return { code: 'None', prec: P.ATOM };
          }
          if (src.includes('\n')) {
            c.fail(tr('A Python Expression is one line. Use Python Code for several lines.'), 'code');
            return { code: 'None', prec: P.ATOM };
          }
          const valid = names.filter((n) => {
            if (VS.isIdentifier(n)) return true;
            c.fail(tr('"{name}" cannot be used as a name. Use letters, digits and _, and do not start with a digit.', { name: n }), 'inputs');
            return false;
          });
          const toks = tokenize(src).filter((t) => t.kind !== 'comment');
          const text = toks.map((t) => t.text).join('').trim();
          const prec = expressionPrec(toks);
          if (!valid.length) return { code: text, prec };
          if (valid.includes(text)) return c.input(text);
          if (toks.some((t) => t.kind === 'string' && /f/i.test(t.prefix))) {
            return { code: `(lambda ${valid.join(', ')}: ${prec < P.LOW ? `(${text})` : text})(${valid.map((n) => c.arg(n)).join(', ')})`, prec: P.ATOM };
          }
          const sig = (i, step) => {
            for (let j = i + step; j >= 0 && j < toks.length; j += step) if (toks[j].kind !== 'space') return toks[j];
            return null;
          };
          const out = toks.map((t, i) => {
            if (t.kind !== 'name' || !valid.includes(t.text)) return t.text;
            const before = sig(i, -1);
            const after = sig(i, 1);
            if (before && before.kind === 'op' && before.text === '.') return t.text;
            if (after && after.kind === 'op' && after.text === '=') return t.text;
            return wrap(c.input(t.text), P.ATOM);
          });
          return { code: out.join('').trim(), prec };
        },
        dedent(code) {
          const src = String(code ?? '').replace(/\r\n?/g, '\n');
          const inside = stringLines(src);
          const all = src.split('\n').map((l, i) => (inside.has(i) ? { text: l, raw: true }
            : { text: l.replace(/^[ \t]+/, (m) => m.replace(/\t/g, '    ')), raw: false }));
          const blank = (l) => !l.raw && !l.text.trim();
          while (all.length && blank(all[0])) all.shift();
          while (all.length && blank(all[all.length - 1])) all.pop();
          const widths = all.filter((l) => !l.raw && l.text.trim()).map((l) => l.text.length - l.text.trimStart().length);
          const cut = widths.length ? Math.min(...widths) : 0;
          return all.map((l) => (l.raw ? l : { text: l.text.trim() ? l.text.slice(cut) : '', raw: false }));
        },
      };
      c.def = def;
      return c;
    }

    // Errors found while compiling a statement are raised right before it, at the node that has the error.
    function flush(c) {
      while (c.pending.length) {
        const { node, message } = c.pending.shift();
        emit(`raise RuntimeError(${pyStr(message)})`, node);
      }
    }

    // via: the input pin of the step being compiled that the value reaches it through.
    function valueOf(from, pin, consumer, via) {
      const def = defOf(from);
      if (isPure(from)) {
        if (evaluating.has(from.id)) return { code: 'None', prec: P.ATOM };
        evaluating.add(from.id);
        try {
          const c = context(from, {}, consumer);
          c.via = via;
          return def.compile.expr(c, pin);
        } finally {
          evaluating.delete(from.id);
        }
      }
      if (!silent) uses.push({ stmt: consumer.stmt, pin: via, producer: from.id });
      if (def.compile && def.compile.output) return def.compile.output(context(from, {}, consumer), pin);
      return { code: `${pin}_${from.id}`, prec: P.ATOM };
    }

    function chain(startId, scope) {
      const mine = [];
      let id = startId;
      while (id) {
        const node = nodes.get(id);
        if (!isStatement(node)) break;
        if (path.has(id)) {
          const message = tr('Run-order wires go in a circle here. Use a While or For loop to repeat steps.');
          report(id, message);
          emit(`raise RuntimeError(${pyStr(message)})`, id);
          break;
        }
        path.add(id);
        mine.push(id);
        visited.add(id);
        place(id);
        const c = context(node, scope);
        const next = c.def.compile.stmt(c);
        flush(c);
        id = next ? execNext.get(key(id, next)) : null;
      }
      for (const m of mine) path.delete(m);
    }

    function entry(node, scope) {
      lines = [];
      fn = { id: node.id, assigned: new Set(), params: new Set(node.type === 'fn.define' ? VS.parseNames(VS.propOf(node, 'params')) : []) };
      openBlocks = [];
      enterBlock();
      position.set(node.id, { fn: node.id, path: [] });
      const c = context(node, scope);
      c.def.compile.entry(c);
      flush(c);
      const globals = [...fn.assigned].filter((n) => scriptVariables.has(n) && !fn.params.has(n)).sort();
      const at = lines.findIndex((l) => /^def /.test(l.text));
      if (globals.length && at >= 0) lines.splice(at + 1, 0, { text: `    global ${globals.join(', ')}`, node: node.id });
      fn = null;
      return lines;
    }

    const blocks = defines.map((d) => entry(d, { fn: true }));
    let main;
    if (starts.length) main = entry(starts[0], {});
    else main = [{ text: 'def main():', node: null }, { text: '    pass', node: null }];

    for (const u of uses) {
      if (u.producer === u.stmt || runsBefore(u.producer, u.stmt)) continue;
      const p = nodes.get(u.producer);
      report(u.stmt, tr('This step uses a value from {node}, which does not always run before it. Wire the value from a step that runs earlier, or store it with Set Variable.',
        { node: `${VS.titleOf(p)} (${p.id})` }), u.pin ? { pin: u.pin } : {});
    }
    for (const n of sorted) {
      if (isStatement(n) && !visited.has(n.id)) {
        report(n.id, tr('This step never runs: nothing connects it to Start or a Define Function.'), { warning: true });
      }
    }

    const out = [{ text: `# Generated by PyIDE from ${fileName}. Edit the .pyflow file, not this file.`, node: null }];
    const blank = () => out.push({ text: '', node: null });
    if (imports.size || fromImports.size) {
      blank();
      for (const m of [...imports.keys()].sort()) out.push({ text: `import ${m}`, node: imports.get(m) });
      for (const m of [...fromImports.keys()].sort()) {
        const names = fromImports.get(m);
        out.push({ text: `from ${m} import ${[...names.keys()].sort().join(', ')}`, node: names.values().next().value });
      }
    }
    const bodyStart = out.length;
    for (const b of [...blocks, main]) {
      blank();
      blank();
      out.push(...b);
    }
    blank();
    blank();
    out.push({ text: 'if __name__ == "__main__":', node: null }, { text: '    main()', node: null });

    // For a debugger: each node's own lines (import lines left out), and the expression that gives each data output's
    // value once its node has run: the generated local of an exec node, the inline expression of a pure node.
    const nodeLines = {};
    for (let i = bodyStart; i < out.length; i++) {
      const id = out[i].node;
      if (id) (nodeLines[id] || (nodeLines[id] = [])).push(i + 1);
    }
    const pinExpr = {};
    silent = true;
    for (const n of sorted) {
      const def = defOf(n);
      if (!def || !def.compile) continue;
      for (const p of pinsOf(n).outputs) {
        let code = null;
        try {
          if (isPure(n) || def.compile.output) code = valueOf(n, p.id, { pending: [] }).code;
          else if (usedOut.has(key(n.id, p.id))) code = `${p.id}_${n.id}`;
        } catch {}
        if (code !== null) (pinExpr[n.id] || (pinExpr[n.id] = {}))[p.id] = code;
      }
    }
    silent = false;
    return {
      code: `${out.map((l) => l.text).join('\n')}\n`,
      map: [null, ...out.map((l) => l.node)],
      errors,
      pinExpr,
      nodeLines,
    };
  };

  if (typeof module === 'object' && module.exports) module.exports = VS;
})(typeof window !== 'undefined' ? window : globalThis);
