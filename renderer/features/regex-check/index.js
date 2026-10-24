// Check RegExp (PyCharm's intention of the same name): on the pattern string of re.compile/search/match/fullmatch/
// findall/finditer/sub/subn/split, the context actions offer a popup that tests the pattern on sample text as you type.
// Matches are highlighted in the sample, the groups (numbered and named) of the selected match are listed, and the
// status says whether it matches or where the pattern has a syntax error. Patterns are evaluated by Python's own `re`
// (main/features/regex-check.js runs regex_check.py in a local interpreter), so Python-only syntax ((?P<name>…),
// possessive quantifiers, atomic groups) and the flags of the call (re.I/M/S/X/A, positional or flags=) behave exactly
// as at run time. Regex syntax inside those string literals is also colored with decorations.
(() => {
  const monaco = ide.monaco;
  const { el } = ide.util;
  const FUNCS = ['compile', 'search', 'match', 'fullmatch', 'findall', 'finditer', 'sub', 'subn', 'split'];
  // Where the flags and the subject string are among the positional arguments (the pattern is argument 0).
  const FLAGS_ARG = { compile: 1, search: 2, match: 2, fullmatch: 2, findall: 2, finditer: 2, split: 3, sub: 4, subn: 4 };
  const STRING_ARG = { search: 1, match: 1, fullmatch: 1, findall: 1, finditer: 1, split: 1, sub: 2, subn: 2 };
  const LONG_FLAGS = { IGNORECASE: 'I', MULTILINE: 'M', DOTALL: 'S', VERBOSE: 'X', ASCII: 'A', UNICODE: 'U', LOCALE: 'L', TEMPLATE: 'T' };
  const SHOWN_FLAGS = ['I', 'M', 'S', 'X', 'A'];
  const CALL_BEFORE = new RegExp(`(?:^|[^\\w.])re\\s*\\.\\s*(${FUNCS.join('|')})\\s*\\(\\s*(?:pattern\\s*=\\s*)?$`);
  const HAS_CALL = new RegExp(`\\bre\\s*\\.\\s*(?:${FUNCS.join('|')})\\s*\\(`);

  // ---------- Python string literals ----------
  // Every string literal of a Python source: {start (prefix included), prefix, quote, bodyStart, bodyEnd, end, raw, bytes, f}.
  function scanLiterals(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '#') { const j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (c !== '"' && c !== "'") { i++; continue; }
      let p = i;
      while (p > 0 && i - p < 2 && /[rRbBuUfF]/.test(text[p - 1])) p--;
      if (p > 0 && /\w/.test(text[p - 1])) p = i;
      let prefix = text.slice(p, i).toLowerCase();
      if (!/^(r|u|b|br|rb|f|fr|rf)?$/.test(prefix)) { p = i; prefix = ''; }
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n && !text.startsWith(quote, j)) {
        if (text[j] === '\\') { j += 2; continue; }
        if (quote.length === 1 && text[j] === '\n') break;
        j++;
      }
      const closed = j < n && text.startsWith(quote, j);
      const end = closed ? j + quote.length : Math.min(j, n);
      out.push({ start: p, prefix, quote, bodyStart: i + quote.length, bodyEnd: Math.min(j, n), end, closed, raw: prefix.includes('r'), bytes: prefix.includes('b'), f: prefix.includes('f') });
      i = end;
    }
    return out;
  }

  // The literal's value as Python decodes it (approximately: \N{…} becomes U+FFFD), with map[k] = the source offset of
  // the escape or character that made decoded unit k (map[value.length] is the end of the body). Raw strings map 1:1.
  function decodeLiteral(text, lit) {
    const src = text.slice(lit.bodyStart, lit.bodyEnd);
    const map = [];
    let out = '';
    if (lit.raw) {
      for (let k = 0; k <= src.length; k++) map.push(lit.bodyStart + k);
      return { value: src, map };
    }
    const SIMPLE = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    const put = (s, at) => { out += s; for (let k = 0; k < s.length; k++) map.push(lit.bodyStart + at); };
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c !== '\\') { put(c, i); i++; continue; }
      const nx = src[i + 1];
      if (nx === '\n') { i += 2; continue; }
      if (nx === '\r') { i += src[i + 2] === '\n' ? 3 : 2; continue; }
      if (nx in SIMPLE) { put(SIMPLE[nx], i); i += 2; continue; }
      if (/[0-7]/.test(nx || '')) {
        let j = i + 1;
        while (j < i + 4 && /[0-7]/.test(src[j] || '')) j++;
        put(String.fromCharCode(parseInt(src.slice(i + 1, j), 8)), i);
        i = j;
        continue;
      }
      const hex = (len) => (/^[0-9a-fA-F]+$/.test(src.substr(i + 2, len)) && src.substr(i + 2, len).length === len ? parseInt(src.substr(i + 2, len), 16) : null);
      if (nx === 'x' && hex(2) !== null) { put(String.fromCharCode(hex(2)), i); i += 4; continue; }
      if (!lit.bytes && nx === 'u' && hex(4) !== null) { put(String.fromCharCode(hex(4)), i); i += 6; continue; }
      if (!lit.bytes && nx === 'U' && hex(8) !== null && hex(8) <= 0x10ffff) { put(String.fromCodePoint(hex(8)), i); i += 10; continue; }
      if (!lit.bytes && nx === 'N' && src[i + 2] === '{' && src.indexOf('}', i) > 0) { put('�', i); i = src.indexOf('}', i) + 1; continue; }
      put('\\', i); // an unknown escape keeps its backslash
      i++;
    }
    map.push(lit.bodyEnd);
    return { value: out, map };
  }

  // The re call a literal is the pattern of: {fn, flags: ['I', ...], subject: literal | null}, or null.
  function regexCall(text, lits, lit) {
    if (lit.f || !lit.closed) return null;
    const m = CALL_BEFORE.exec(text.slice(Math.max(0, lit.start - 200), lit.start));
    if (!m) return null;
    const fn = m[1];
    // The call's top-level arguments, the pattern first.
    const byStart = new Map(lits.map((l) => [l.start, l]));
    const args = [];
    let from = lit.start;
    let depth = 0;
    let j = lit.end;
    for (; j < text.length; j++) {
      const c = text[j];
      const l = byStart.get(j);
      if (l) { j = l.end - 1; continue; }
      if (c === '#') { const e = text.indexOf('\n', j); j = e < 0 ? text.length : e; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) { args.push({ from, to: j }); from = j + 1; }
    }
    if (text.slice(from, j).trim()) args.push({ from, to: j });
    const positional = [];
    const keywords = {};
    for (const a of args) {
      const t = text.slice(a.from, a.to);
      const kw = /^\s*(\w+)\s*=(?!=)/.exec(t);
      if (kw) keywords[kw[1]] = { from: a.from + kw[0].length, to: a.to };
      else positional.push(a);
    }
    const flagsArg = keywords.flags || positional[FLAGS_ARG[fn]];
    const flags = new Set();
    if (flagsArg) {
      const t = text.slice(flagsArg.from, flagsArg.to);
      for (const f of t.matchAll(/\bre\s*\.\s*(?:RegexFlag\s*\.\s*)?([A-Z]+)\b/g)) flags.add(LONG_FLAGS[f[1]] || f[1]);
      for (const f of t.matchAll(/(?<![.\w])(IGNORECASE|MULTILINE|DOTALL|VERBOSE|ASCII|UNICODE|LOCALE)\b/g)) flags.add(LONG_FLAGS[f[1]]);
    }
    const stringArg = keywords.string || (STRING_ARG[fn] !== undefined ? positional[STRING_ARG[fn]] : null);
    let subject = null;
    if (stringArg) {
      const t = text.slice(stringArg.from, stringArg.to);
      const at = stringArg.from + t.length - t.trimStart().length;
      const l = byStart.get(at);
      if (l && !l.f && l.end === stringArg.from + t.trimEnd().length) subject = l;
    }
    return { fn, flags: [...flags].filter((f) => /^[IMSXAUL]$/.test(f)), subject };
  }

  // The regex literal around an offset of a model: {lit, call, text, lits} or null.
  function regexAt(model, offset) {
    const text = model.getValue();
    if (!HAS_CALL.test(text)) return null;
    const lits = scanLiterals(text);
    const lit = lits.find((l) => offset >= l.start && offset <= l.end);
    const call = lit && regexCall(text, lits, lit);
    return call ? { lit, call, text, lits } : null;
  }

  // ---------- regex syntax ----------
  // Tokens of a pattern for coloring: [{from, to, cls}] over the decoded pattern.
  function rxTokens(p, verbose) {
    const out = [];
    const push = (from, to, cls) => { if (to > from) out.push({ from, to, cls }); };
    let i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === '\\') {
        const nx = p[i + 1];
        let len = nx === undefined ? 1 : 2;
        if (nx === 'x') len = 4;
        else if (nx === 'u') len = 6;
        else if (nx === 'U') len = 10;
        else if (nx === 'N' && p[i + 2] === '{') len = Math.max(2, p.indexOf('}', i) + 1 - i);
        else if (/\d/.test(nx || '')) { len = 2; while (len < 4 && /\d/.test(p[i + len] || '')) len++; }
        push(i, Math.min(p.length, i + len), /[bBAZ]/.test(nx || '') ? 'rx-anchor' : 'rx-escape');
        i += len;
        continue;
      }
      if (c === '[') {
        let j = i + 1;
        if (p[j] === '^') j++;
        if (p[j] === ']') j++;
        while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1;
        push(i, Math.min(p.length, j + 1), 'rx-class');
        i = j + 1;
        continue;
      }
      if (c === '(') {
        let j = i + 1;
        let cls = 'rx-group';
        if (p[j] === '?') {
          j++;
          if (p[j] === '#') { j = p.indexOf(')', j); j = j < 0 ? p.length : j + 1; cls = 'rx-comment'; }
          else if (p[j] === 'P' && p[j + 1] === '=') { j = p.indexOf(')', j); j = j < 0 ? p.length : j + 1; cls = 'rx-escape'; }
          else if ((p[j] === 'P' && p[j + 1] === '<') || (p[j] === '<' && !'=!'.includes(p[j + 1]))) { const e = p.indexOf('>', j); j = e < 0 ? p.length : e + 1; }
          else if (p[j] === '<') j += 2;
          else if (p[j] === '(') { const e = p.indexOf(')', j); j = e < 0 ? p.length : e + 1; }
          else { while (/[aiLmsux-]/.test(p[j] || '')) j++; if (/[:=!>)]/.test(p[j] || '')) j++; }
        }
        push(i, j, cls);
        i = j;
        continue;
      }
      if (c === ')') { push(i, i + 1, 'rx-group'); i++; continue; }
      const quant = /^(?:[*+?]|\{\d*,?\d*\})[?+]?/.exec(p.slice(i, i + 24));
      if (quant && (c !== '{' || /\d/.test(quant[0]))) { push(i, i + quant[0].length, 'rx-quant'); i += quant[0].length; continue; }
      if (c === '^' || c === '$') { push(i, i + 1, 'rx-anchor'); i++; continue; }
      if (c === '|') { push(i, i + 1, 'rx-alt'); i++; continue; }
      if (verbose && c === '#') { const e = p.indexOf('\n', i); push(i, e < 0 ? p.length : e, 'rx-comment'); i = e < 0 ? p.length : e; continue; }
      i++;
    }
    return out;
  }

  // Decorations for every regex literal of a Python model (only when the file calls re at all).
  const colored = new Map(); // model -> {collection ids, timer}
  function colorModel(model) {
    if (model.isDisposed()) return;
    const state = colored.get(model);
    const text = model.getValue();
    const decos = [];
    if (text.length < 2_000_000 && HAS_CALL.test(text)) {
      const lits = scanLiterals(text);
      for (const lit of lits) {
        if (lit.f || !lit.closed || !CALL_BEFORE.test(text.slice(Math.max(0, lit.start - 200), lit.start))) continue;
        const { value, map } = decodeLiteral(text, lit);
        const verbose = (() => { const call = regexCall(text, lits, lit); return !!call?.flags.includes('X') || /^\(\?[aiLmsu]*x/.test(value); })();
        for (const t of rxTokens(value, verbose)) {
          const from = map[t.from];
          const to = map[Math.min(t.to, value.length)];
          if (from === undefined || to === undefined || to <= from) continue;
          decos.push({ range: monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to)), options: { inlineClassName: t.cls, stickiness: 1 } });
        }
      }
    }
    state.ids = model.deltaDecorations(state.ids, decos);
  }
  function watchModel(model) {
    if (!model || colored.has(model) || model.getLanguageId() !== 'python') return;
    const state = { ids: [], timer: null };
    colored.set(model, state);
    const sub = model.onDidChangeContent(() => { clearTimeout(state.timer); state.timer = setTimeout(() => colorModel(model), 250); });
    model.onWillDispose(() => { clearTimeout(state.timer); sub.dispose(); colored.delete(model); });
    colorModel(model);
  }
  ide.on('fileOpened', (tab) => watchModel(tab?.model));
  for (const t of ide.tabs) if (t.kind === 'file') watchModel(t.model);

  // ---------- evaluation ----------
  const localInterp = () => {
    const local = (i) => i && !i.target && (i.executable || i.cmd);
    const it = local(ide.currentInterp()) ? ide.currentInterp() : ide.interps.find((i) => !i.invalid && local(i));
    return it ? { cmd: it.cmd, args: it.args || [], executable: it.executable } : null;
  };
  const interpKey = (i) => (i ? i.executable || i.cmd : null);
  let helperKey = null; // the interpreter the helper was last asked to use
  const evaluate = (req) => {
    const interp = localInterp();
    helperKey = interpKey(interp);
    return ide.api.invoke('regex-check:eval', interp, req);
  };
  // The helper runs in the project's interpreter (a venv's python.exe keeps the venv locked), so it stops when the
  // project closes or opens and when the interpreter becomes another one (a reloaded list with the same one leaves a
  // check in flight alone); the next check starts a helper in the new interpreter.
  const stopHelper = () => { helperKey = null; ide.api.invoke('regex-check:stop').catch(() => {}); };
  ide.on('interpreterChanged', () => { if (helperKey && helperKey !== interpKey(localInterp())) stopHelper(); });
  ide.on('projectClosed', stopHelper);
  ide.on('projectOpened', stopHelper);

  // ---------- popup ----------
  const samples = new Map(); // literal source -> the sample last typed for it (this session)
  let popup = null;

  function close(focusEditor = false) {
    if (!popup) return;
    const p = popup;
    popup = null;
    clearTimeout(p.timer);
    p.dispose();
    p.el.remove();
    if (focusEditor) p.editor.focus();
  }

  function open(editor, offset) {
    const model = editor?.getModel();
    if (!model) return false;
    const found = regexAt(model, offset ?? model.getOffsetAt(editor.getPosition()));
    if (!found) return false;
    close();
    const { lit, call, text } = found;
    const literal = text.slice(lit.start, lit.end);
    const decoded = decodeLiteral(text, lit);
    const mode = call.fn === 'match' || call.fn === 'fullmatch' ? call.fn : 'search';
    const flags = new Set(call.flags);

    const root = el('div', 'rx-popup');
    root.id = 'rxPopup';
    root.tabIndex = -1;
    const head = el('div', 'rx-head');
    const title = el('span', 'rx-title', tr('Check RegExp'));
    const fn = el('span', 'rx-fn', `re.${call.fn}`);
    fn.dataset.userText = '';
    const flagBox = el('span', 'rx-flags');
    const FLAG_TITLES = { I: () => tr('Ignore case (re.I)'), M: () => tr('Multiline: ^ and $ at every line (re.M)'), S: () => tr('Dot matches newlines too (re.S)'), X: () => tr('Verbose: whitespace and # comments ignored (re.X)'), A: () => tr('ASCII-only \\w, \\d and \\s (re.A)') };
    for (const f of SHOWN_FLAGS) {
      const b = el('button', 'rx-flag', f);
      b.dataset.flag = f;
      b.title = FLAG_TITLES[f]();
      b.setAttribute('aria-pressed', String(flags.has(f)));
      b.onclick = () => {
        flags.has(f) ? flags.delete(f) : flags.add(f);
        b.setAttribute('aria-pressed', String(flags.has(f)));
        run(0);
      };
      flagBox.append(b);
    }
    head.append(title, fn, flagBox);
    const pattern = el('div', 'rx-pattern');
    pattern.dataset.userText = '';
    const sampleWrap = el('div', 'rx-sample-wrap');
    const backdrop = el('div', 'rx-backdrop');
    const sample = el('textarea', 'rx-sample');
    sample.spellcheck = false;
    sample.placeholder = tr('Sample text');
    sample.value = samples.get(literal) ?? (call.subject ? decodeLiteral(text, call.subject).value : '');
    sampleWrap.append(backdrop, sample);
    const status = el('div', 'rx-status');
    const groups = el('div', 'rx-groups');
    root.append(head, pattern, sampleWrap, status, groups);
    document.querySelector('#editorArea').append(root);

    // Below the literal, or above it when there is no room.
    const place = () => {
      const pos = model.getPositionAt(lit.start);
      const vis = editor.getScrolledVisiblePosition(pos);
      const box = editor.getDomNode().getBoundingClientRect();
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      let left = box.left + (vis?.left ?? 0);
      let top = box.top + (vis ? vis.top + vis.height + 4 : 40);
      if (top + h > innerHeight - 8 && vis) top = Math.max(8, box.top + vis.top - h - 4);
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };

    const errorDeco = editor.createDecorationsCollection();
    const state = { result: null, current: 0, seq: 0, pending: 0 };

    function showPattern(r) {
      pattern.replaceChildren();
      const p = r?.pattern ?? decoded.value;
      const pos = r?.error?.kind === 'syntax' && r.error.pos !== null && r.error.pos !== undefined ? Math.min(r.error.pos, p.length) : -1;
      if (pos < 0) { pattern.textContent = p; return; }
      pattern.append(document.createTextNode(p.slice(0, pos)), el('span', 'rx-error-at', p.slice(pos, pos + 1) || ' '), document.createTextNode(p.slice(pos + 1)));
    }

    function showMatches() {
      const r = state.result;
      const v = sample.value;
      backdrop.replaceChildren();
      let at = 0;
      const matches = r?.ok ? r.matches : [];
      matches.forEach((m, i) => {
        const [s, e] = m.span;
        if (s < at) return;
        if (s > at) backdrop.append(document.createTextNode(v.slice(at, s)));
        const mark = el('mark', `rx-m${i % 2 ? ' rx-m-alt' : ''}${i === state.current ? ' rx-m-current' : ''}${s === e ? ' rx-m-empty' : ''}`, v.slice(s, e));
        mark.dataset.match = String(i);
        backdrop.append(mark);
        at = e;
      });
      backdrop.append(document.createTextNode(`${v.slice(at)}\n`));
      backdrop.scrollTop = sample.scrollTop;
    }

    function showGroups() {
      const r = state.result;
      groups.replaceChildren();
      if (!r?.ok || !r.matches.length) return;
      const m = r.matches[state.current];
      const nav = el('div', 'rx-nav');
      const prev = el('button', 'rx-prev', '‹');
      prev.title = tr('Previous match');
      const next = el('button', 'rx-next', '›');
      next.title = tr('Next match');
      prev.disabled = state.current === 0;
      next.disabled = state.current >= r.matches.length - 1;
      // The list is drawn again; the keyboard stays on the same button, or on the popup once that button is disabled.
      const step = (d, cls) => {
        state.current += d;
        showMatches();
        showGroups();
        const b = groups.querySelector(cls);
        (b && !b.disabled ? b : root).focus();
      };
      prev.onclick = () => step(-1, '.rx-prev');
      next.onclick = () => step(1, '.rx-next');
      nav.append(prev, el('span', 'rx-nav-label', tr('Match {n} of {total}', { n: state.current + 1, total: r.matches.length + (r.truncated ? '+' : '') })), next);
      groups.append(nav);
      const table = el('table', 'rx-group-table');
      const names = Object.fromEntries(Object.entries(r.names || {}).map(([k, i]) => [i, k]));
      const v = sample.value;
      const row = (label, span, isName) => {
        const tr_ = el('tr');
        const l = el('td', 'rx-g-label', label);
        if (isName) l.dataset.userText = '';
        const val = span ? el('td', 'rx-g-value', v.slice(span[0], span[1])) : el('td', 'rx-g-value rx-g-none', tr('(no match)'));
        if (span) val.dataset.userText = '';
        tr_.append(l, val, el('td', 'rx-g-span', span ? `${span[0]}–${span[1]}` : ''));
        table.append(tr_);
      };
      row(tr('Match'), m.span);
      m.groups.forEach((span, i) => row(names[i + 1] ? `${i + 1} ‹${names[i + 1]}›` : String(i + 1), span, !!names[i + 1]));
      groups.append(table);
    }

    function showStatus() {
      const r = state.result;
      status.replaceChildren();
      errorDeco.clear();
      let kind = 'none';
      if (!r) return;
      if (r.ok) {
        kind = r.matches.length ? 'ok' : 'none';
        const n = r.matches.length;
        const text = !n ? tr('No match') : mode !== 'search' ? tr('Matches') : n === 1 ? tr('Matches: 1 match') : tr('Matches: {n} matches', { n: `${n}${r.truncated ? '+' : ''}` });
        status.append(el('span', 'rx-status-icon', n ? '✓' : '✗'), el('span', 'rx-status-text', text));
      } else {
        const e = r.error || {};
        kind = 'error';
        let text;
        if (e.kind === 'syntax' && e.pos !== null && e.pos !== undefined) text = tr('Syntax error at position {pos}:', { pos: e.pos });
        else if (e.kind === 'syntax') text = tr('Invalid pattern:');
        else if (e.kind === 'timeout') text = tr('The pattern took longer than {s} s on this text (catastrophic backtracking?)', { s: Math.round((e.ms || 3000) / 1000) });
        else if (e.kind === 'literal') text = tr('This is not a plain string literal');
        else if (e.kind === 'no-interpreter') text = tr('No local Python interpreter to check the pattern with');
        else text = tr('The pattern could not be checked:');
        status.append(el('span', 'rx-status-icon', '!'), el('span', 'rx-status-text', text));
        if (e.msg && (e.kind === 'syntax' || e.kind === 'internal')) { const m = el('span', 'rx-status-msg', ` ${e.msg}`); m.dataset.userText = ''; status.append(m); }
        // The character at fault, in the editor too.
        if (e.kind === 'syntax' && Number.isInteger(e.pos) && r.pattern?.length === decoded.value.length && !model.isDisposed()) {
          const from = decoded.map[Math.min(e.pos, decoded.value.length)];
          const to = e.pos < decoded.value.length ? decoded.map[e.pos + 1] : from + 1;
          errorDeco.set([{ range: monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(Math.max(to, from + 1))), options: { inlineClassName: 'rx-error-char' } }]);
        }
      }
      status.className = `rx-status rx-status-${kind}`;
      root.dataset.state = kind;
    }

    // Evaluates now (delay 0) or after a pause in typing; only the latest answer is shown.
    function run(delay = 150) {
      clearTimeout(p.timer);
      p.timer = setTimeout(async () => {
        const seq = ++state.seq;
        state.pending++;
        root.dataset.busy = 'true';
        const r = await evaluate({ literal, flags: [...flags], mode, text: sample.value, limit: 1000 }).catch((err) => ({ ok: false, error: { kind: 'internal', msg: err.message } }));
        state.pending--;
        if (seq !== state.seq || popup !== p) return;
        delete root.dataset.busy;
        state.result = r;
        state.current = Math.min(state.current, Math.max(0, (r.ok ? r.matches.length : 1) - 1));
        root.dataset.evaluated = String(seq);
        showPattern(r);
        showStatus();
        showMatches();
        showGroups();
        place();
      }, delay);
    }

    sample.addEventListener('input', () => { samples.set(literal, sample.value); state.current = 0; showMatches(); run(); });
    sample.addEventListener('scroll', () => { backdrop.scrollTop = sample.scrollTop; });
    // Esc closes the popup before the global keymap sees it (capture phase), wherever the keyboard is inside it.
    const onKey = (e) => {
      if (e.key !== 'Escape' || !(root.contains(document.activeElement) || document.activeElement === document.body)) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const outside = (e) => { if (!root.contains(e.target)) close(); };
    const subs = [
      model.onDidChangeContent(() => close()),
      editor.onDidChangeModel(() => close()),
      editor.onDidScrollChange(() => place()),
      ide.on('activeTabChanged', () => close()),
    ];
    addEventListener('mousedown', outside, true);
    addEventListener('keydown', onKey, true);
    const p = {
      el: root, editor, timer: null, state, literal, mode, flags, run,
      dispose() {
        removeEventListener('mousedown', outside, true);
        removeEventListener('keydown', onKey, true);
        for (const s of subs) (typeof s === 'function' ? s() : s.dispose());
        errorDeco.clear();
      },
    };
    popup = p;
    showPattern(null);
    showMatches();
    place();
    sample.focus();
    run(0);
    return true;
  }

  // ---------- context action and action ----------
  const COMMAND = 'pyide.regexCheck.open';
  monaco.editor.registerCommand(COMMAND, (_accessor, offset) => open(ide.editor, offset));
  monaco.languages.registerCodeActionProvider('python', {
    provideCodeActions(model, range, context) {
      if (context.trigger !== monaco.languages.CodeActionTriggerType.Invoke) return undefined;
      const offset = model.getOffsetAt(range.getStartPosition());
      if (!regexAt(model, offset)) return undefined;
      return { actions: [{ title: tr('Check RegExp'), kind: 'quickfix', command: { id: COMMAND, title: tr('Check RegExp'), arguments: [offset] } }], dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  ide.registerAction({
    id: 'RegExp.Check', title: tr('Check RegExp'),
    run: () => {
      const editor = ide.editor;
      if (open(editor)) return;
      const ctl = editor?.getContribution('editor.contrib.messageController');
      if (ctl && editor.getPosition()) ctl.showMessage(tr('Put the caret on the pattern of a re function call'), editor.getPosition());
    },
  });

  // For tests and other plugins.
  ide.regexCheck = {
    open: (offset) => open(ide.editor, offset),
    close,
    isOpen: () => !!popup,
    state: () => (popup ? { result: popup.state.result, current: popup.state.current, mode: popup.mode, flags: [...popup.flags], literal: popup.literal, pending: popup.state.pending } : null),
    scanLiterals,
    decodeLiteral,
    regexAt,
  };
})();
