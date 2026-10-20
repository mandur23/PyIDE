// Inlay hints for Python: inferred variable types, call argument names and inferred return types.
// The bundled Pyright does not implement textDocument/inlayHint (that is Pylance only), so the places come from
// Monaco's tokens and the text of each hint from Pyright: hover for types, signatureHelp for parameter names.
(() => {
  const monaco = ide.monaco;
  const KEYS = {
    enabled: 'editor.inlayHints',
    types: 'editor.inlayHints.variableTypes',
    params: 'editor.inlayHints.parameterNames',
    returns: 'editor.inlayHints.returnTypes',
  };
  const DEFAULTS = Object.fromEntries(Object.values(KEYS).map((k) => [k, true]));
  const on = (name) => ide.settings.get(KEYS[name], true) !== false;
  const MAX_TYPE = 60;

  // ---------- where hints go ----------
  // Monaco asks for the lines in view after every pause in typing. Tokenizing the whole model each time cost 150 ms on a
  // 12,000-line file, so only the lines asked for are tokenized, from the nearest line above them that starts a
  // top-level statement outside a string (where a fresh tokenizer and bracket depth 0 are right), plus a margin below
  // for calls and signatures that run on. Cached per model version and window.
  const MARGIN = 40;
  const STANDARD_COMMENT = 1;
  const STANDARD_STRING = 2;
  function statementStart(model, ln) {
    if (!/^[A-Za-z_@]/.test(model.getLineContent(ln))) return false;
    model.tokenization.forceTokenization(ln);
    const type = model.tokenization.getLineTokens(ln).getStandardTokenType(0);
    return type !== STANDARD_STRING && type !== STANDARD_COMMENT;
  }
  const scans = new WeakMap();
  function tokensOf(model, range) {
    let from = range.startLineNumber;
    while (from > 1 && !statementStart(model, from)) from--;
    const to = Math.min(model.getLineCount(), range.endLineNumber + MARGIN);
    const cached = scans.get(model);
    if (cached?.version === model.getVersionId() && cached.from <= from && cached.to >= to) return cached.sites;
    const lines = [];
    for (let ln = from; ln <= to; ln++) lines.push(model.getLineContent(ln));
    const raw = monaco.editor.tokenize(lines.join('\n'), 'python');
    const toks = [];
    raw.forEach((lineToks, i) => {
      const text = lines[i];
      lineToks.forEach((t, j) => {
        const end = j + 1 < lineToks.length ? lineToks[j + 1].offset : text.length;
        const s = text.slice(t.offset, end);
        if (!s.trim()) return;
        const type = t.type.replace(/\.python$/, '');
        // Monarch merges neighbouring tokens of one type ("()", "))", "),"); split brackets and separators back out.
        const parts = type.startsWith('delimiter') ? s.split(/([()[\]{},;])/) : [s];
        let k = t.offset;
        for (const part of parts) {
          const lead = part.length - part.trimStart().length;
          const body = part.trim();
          if (body) toks.push({ line: from + i, col: k + lead + 1, end: k + lead + body.length + 1, text: body, type });
          k += part.length;
        }
      });
    });
    const sites = findSites(toks, (ln) => lines[ln - from]);
    scans.set(model, { version: model.getVersionId(), from, to, sites });
    return sites;
  }

  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);
  const isName = (t) => t && (t.type === 'identifier' || t.type === 'self');
  const LITERAL = (t) => t && (t.type.startsWith('string') || t.type === 'number' || (t.type === 'keyword' && ['True', 'False', 'None'].includes(t.text)));

  // lineAt(n): the text of line n.
  function findSites(toks, lineAt) {
    const vars = [];
    const calls = [];
    const defs = [];
    let depth = 0;
    let stmtStart = true;
    const stack = []; // open brackets: {tok, call}
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const prev = toks[i - 1];
      // A new physical line at bracket depth 0 starts a statement unless the previous line ends with a backslash.
      if (prev && t.line !== prev.line && depth === 0 && !/\\\s*$/.test(lineAt(prev.line))) stmtStart = true;
      if (t.type === 'comment') continue;
      if (stmtStart && depth === 0) {
        stmtStart = false;
        statementAt(toks, i, vars, defs);
      }
      if (t.text === ';' && depth === 0) { stmtStart = true; continue; }
      if (OPEN.has(t.text)) {
        const callee = prev && prev.line === t.line && prev.end === t.col && t.text === '('
          && (prev.type === 'function.call' || prev.type === 'builtin' || isName(prev))
          && toks[i - 2]?.text !== 'def' && toks[i - 2]?.text !== 'class' ? prev : null;
        const entry = { tok: t, call: callee ? { callee, open: t, args: [], positional: true } : null, expectArg: true };
        stack.push(entry);
        depth++;
        if (entry.call) calls.push(entry.call);
        continue;
      }
      if (CLOSE.has(t.text)) {
        stack.pop();
        depth = Math.max(0, depth - 1);
        const top = stack[stack.length - 1];
        if (top) top.expectArg = false;
        continue;
      }
      const top = stack[stack.length - 1];
      if (top?.call) {
        if (t.text === ',') { top.expectArg = true; continue; }
        if (top.expectArg) {
          top.expectArg = false;
          const c = top.call;
          if (!c.positional) continue;
          if (t.text === '*' || t.text === '**' || t.text.startsWith('*')) { c.positional = false; continue; }
          const next = toks[i + 1];
          if (isName(t) && next?.text === '=') { c.positional = false; continue; }
          const simple = (isName(t) || t.type === 'function.call') && (next?.text === ',' || next?.text === ')') ? t.text : null;
          c.args.push({ line: t.line, col: t.col, simple });
        }
      } else if (top) {
        top.expectArg = false;
      }
    }
    return { vars, calls: calls.filter((c) => c.args.length), defs };
  }

  // Assignment targets (`a = …`, `a, b = …`), loop targets and `with … as name`, and unannotated `def`s.
  function statementAt(toks, i, vars, defs) {
    const t = toks[i];
    const line = t.line;
    const sameLine = (k) => toks[k] && toks[k].line === line;
    if (t.text === 'def' || (t.text === 'async' && toks[i + 1]?.text === 'def')) {
      const k = t.text === 'async' ? i + 1 : i;
      const name = toks[k + 1];
      if (!name || toks[k + 2]?.text !== '(') return;
      let d = 0;
      for (let j = k + 2; j < toks.length; j++) {
        if (OPEN.has(toks[j].text)) d++;
        else if (CLOSE.has(toks[j].text) && --d === 0) {
          const after = toks[j + 1];
          if (after && after.text.startsWith(':')) defs.push({ name, close: toks[j] });
          return;
        }
      }
      return;
    }
    if (t.text === 'for' || (t.text === 'async' && toks[i + 1]?.text === 'for')) {
      for (let j = t.text === 'async' ? i + 2 : i + 1; sameLine(j) && toks[j].text !== 'in'; j++) {
        if (isName(toks[j]) && toks[j].type === 'identifier') vars.push({ tok: toks[j], rhs: null });
      }
      return;
    }
    if (t.text === 'with' || (t.text === 'async' && toks[i + 1]?.text === 'with')) {
      for (let j = i + 1; sameLine(j) && !toks[j].text.startsWith(':'); j++) {
        if (toks[j].text === 'as' && isName(toks[j + 1]) && toks[j + 1].type === 'identifier') vars.push({ tok: toks[j + 1], rhs: null });
      }
      return;
    }
    if (!isName(t) || t.type !== 'identifier') return;
    const targets = [t];
    let j = i + 1;
    while (toks[j]?.text === ',' && isName(toks[j + 1]) && sameLine(j + 1)) {
      targets.push(toks[j + 1]);
      j += 2;
    }
    if (toks[j]?.text !== '=' || !sameLine(j)) return;
    const rhs = [];
    for (let k = j + 1; sameLine(k); k++) if (toks[k].type !== 'comment') rhs.push(toks[k]);
    for (const tok of targets) vars.push({ tok, rhs: targets.length === 1 ? rhs : null });
  }

  // ---------- hint texts from Pyright ----------
  const codeOf = (contents) => {
    const v = typeof contents === 'string' ? contents : Array.isArray(contents) ? contents.map((c) => c.value || c).join('\n') : contents?.value || '';
    const m = /```(?:python)?\n([\s\S]*?)```/.exec(v);
    return (m ? m[1] : v).trim();
  };
  // Pyright infers literal types (`Literal['hi']`); a hint shows the class, as PyCharm does (`str`).
  const literalClass = (member) => {
    const m = member.trim();
    if (/^[rRuU]?['"]/.test(m)) return 'str';
    if (/^[bB]['"]/.test(m)) return 'bytes';
    if (m === 'True' || m === 'False') return 'bool';
    if (/^-?\d+$/.test(m)) return 'int';
    return null;
  };
  const widen = (type) => {
    const out = type.replace(/Literal\[((?:[^\[\]'"]|'[^']*'|"[^"]*")*)\]/g, (all, members) => {
      const kinds = [...new Set(members.match(/'[^']*'|"[^"]*"|[^,]+/g).map(literalClass))];
      return kinds.length === 1 && kinds[0] ? kinds[0] : all;
    });
    return [...new Set(out.split(' | '))].join(' | ');
  };
  const shorten = (type) => (type.length > MAX_TYPE ? `${type.slice(0, MAX_TYPE - 1)}…` : type);

  async function variableType(uri, tok) {
    const r = await ide.lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: tok.line - 1, character: tok.col - 1 } });
    const code = codeOf(r?.contents);
    const m = /^\((?:variable|constant)\)\s+[\w.]+:\s*([\s\S]+)$/.exec(code.split('\n\n')[0]);
    if (!m) return null;
    const type = m[1].replace(/\s*\n\s*/g, ' ').trim();
    return /\bUnknown\b/.test(type) ? null : widen(type);
  }

  async function returnType(uri, def) {
    const r = await ide.lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: def.name.line - 1, character: def.name.col - 1 } });
    const code = codeOf(r?.contents).split('\n\n')[0];
    const at = code.indexOf(`${def.name.text}(`);
    if (!/^\((?:function|method)\)/.test(code) || at < 0) return null;
    let d = 0;
    for (let i = at + def.name.text.length; i < code.length; i++) {
      if (code[i] === '(' || code[i] === '[') d++;
      else if ((code[i] === ')' || code[i] === ']') && --d === 0) {
        const m = /^\s*->\s*([\s\S]+)$/.exec(code.slice(i + 1));
        if (!m) return null;
        const type = m[1].replace(/\s*\n\s*/g, ' ').trim();
        return /\bUnknown\b/.test(type) ? null : widen(type);
      }
    }
    return null;
  }

  // Parameter names for a call's positional arguments; positional-only and variadic parameters get none.
  async function parameterNames(uri, call) {
    const r = await ide.lsp.request('textDocument/signatureHelp', {
      textDocument: { uri }, position: { line: call.open.line - 1, character: call.open.col },
      context: { triggerKind: 1, isRetrigger: false },
    });
    const sig = r?.signatures?.[r.activeSignature ?? 0];
    if (!sig || (r.signatures.length > 1 && sig.parameters?.length !== r.signatures[0].parameters?.length)) return [];
    const labels = (sig.parameters || []).map((p) => (Array.isArray(p.label) ? sig.label.slice(p.label[0], p.label[1]) : p.label));
    const names = [];
    for (const label of labels) {
      const name = label.split(/[:=]/)[0].trim();
      if (name === '/') { names.fill(null); continue; }
      if (name.startsWith('*')) break;
      names.push(/^[A-Za-z_]\w*$/.test(name) ? name : null);
    }
    return names;
  }

  // ---------- provider ----------
  const changed = new monaco.Emitter();
  const cache = new WeakMap(); // model -> {version, map}
  function memo(model, key, fn) {
    let c = cache.get(model);
    if (!c || c.version !== model.getVersionId()) cache.set(model, (c = { version: model.getVersionId(), map: new Map() }));
    if (!c.map.has(key)) c.map.set(key, fn().catch(() => null));
    return c.map.get(key);
  }

  const inRange = (range, line) => line >= range.startLineNumber && line <= range.endLineNumber;
  const obviousType = (rhs, type) => {
    if (!rhs?.length) return false;
    if (rhs.length === 1 && LITERAL(rhs[0])) return true;
    if (rhs.every((x) => x.type.startsWith('string'))) return true;
    // `x = Shape(…)` already says the type.
    const callee = rhs[0];
    return rhs[1]?.text === '(' && (callee.text === type || callee.text === type.replace(/\[.*$/, ''));
  };

  async function provide(model, range, token) {
    const empty = { hints: [], dispose() {} };
    if (!on('enabled') || model.uri.scheme !== 'file' || !ide.lsp || ide.lsp.status() !== 'ready') return empty;
    const uri = model.uri.toString();
    const sites = tokensOf(model, range);
    const jobs = [];
    const K = monaco.languages.InlayHintKind;
    if (on('types')) {
      for (const v of sites.vars) {
        if (!inRange(range, v.tok.line)) continue;
        jobs.push(memo(model, `v${v.tok.line}:${v.tok.col}`, () => variableType(uri, v.tok)).then((type) => (type && !obviousType(v.rhs, type)
          ? { label: `: ${shorten(type)}`, position: { lineNumber: v.tok.line, column: v.tok.end }, kind: K.Type } : null)));
      }
    }
    if (on('returns')) {
      for (const d of sites.defs) {
        if (!inRange(range, d.close.line)) continue;
        jobs.push(memo(model, `r${d.name.line}:${d.name.col}`, () => returnType(uri, d)).then((type) => (type
          ? { label: `-> ${shorten(type)}`, position: { lineNumber: d.close.line, column: d.close.col + 1 }, kind: K.Type, paddingLeft: true } : null)));
      }
    }
    if (on('params')) {
      for (const c of sites.calls) {
        if (!c.args.some((a) => inRange(range, a.line))) continue;
        jobs.push(memo(model, `c${c.open.line}:${c.open.col}`, () => parameterNames(uri, c)).then((names) => (names || []).map((name, i) => {
          const a = c.args[i];
          if (!name || !a || a.simple === name || a.simple?.toLowerCase().endsWith(name.toLowerCase())) return null;
          return { label: `${name}:`, position: { lineNumber: a.line, column: a.col }, kind: K.Parameter, paddingRight: true };
        })));
      }
    }
    const hints = (await Promise.all(jobs)).flat().filter(Boolean);
    if (token.isCancellationRequested) return empty;
    return { hints, dispose() {} };
  }
  monaco.languages.registerInlayHintsProvider('python', { onDidChangeInlayHints: changed.event, provideInlayHints: provide });

  // Pyright answers once it has analyzed the file; its diagnostics arriving is the signal to ask again.
  let refreshTimer = null;
  const refresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => changed.fire(), 250); };
  ide.on('problemsChanged', refresh);

  const applyOption = () => ide.updateEditorOptions({ inlayHints: { enabled: on('enabled') ? 'on' : 'off', padding: false } });
  ide.on('ready', applyOption);
  applyOption();
  ide.on('settingsChanged', (key) => {
    if (!Object.values(KEYS).includes(key)) return;
    applyOption();
    changed.fire();
  });

  // ---------- Settings › Editor › Inlay Hints ----------
  (ide.settingsPages ||= []).push({
    id: 'inlay-hints', group: 'editor', title: () => tr('Inlay Hints'), defaults: DEFAULTS,
    keywords: 'inlay hints types parameter names arguments return type 인레이 힌트 타입 매개변수 이름 인수 반환',
    mount(host, ctx) {
      const s = ctx.ui.section(host, 'Python');
      s.appendChild(ctx.ui.checkbox(KEYS.enabled, tr('Show inlay hints')));
      s.appendChild(ctx.ui.checkbox(KEYS.types, tr('Inferred types of variables')));
      s.appendChild(ctx.ui.checkbox(KEYS.params, tr('Parameter names in calls')));
      s.appendChild(ctx.ui.checkbox(KEYS.returns, tr('Inferred return types of functions')));
      host.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted settings-note', textContent: tr('Types and parameter names come from Pyright.'),
      }));
    },
  });

  ide.inlayHints = {
    refresh: () => changed.fire(),
    // Hints for the whole model or a range of it, as the provider computes them (verify/refactor.mjs).
    hints: async (model, range = model.getFullModelRange()) => (await provide(model, range, { isCancellationRequested: false })).hints,
  };
})();
