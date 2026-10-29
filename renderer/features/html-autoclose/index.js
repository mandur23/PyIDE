// HTML tag closing, as PyCharm and VS Code do it: typing the `>` that ends a start tag puts its end tag after the caret
// (`<h1>|</h1>`), and typing `</` completes the end tag of the innermost open element (`</h1>|`). Each insertion is its
// own undo step. Not for void elements, `<x/>`, a start tag whose end tag already follows the caret, or a `>` typed in
// a comment, an attribute value, `<!DOCTYPE …>` or the content of script, style, textarea and title (where `</`
// completes that element's own end tag). XML files (pom.xml, .fxml, .svg, .xsd…) get the same, without HTML's void and
// raw-text elements. Settings › Editor › Smart Keys › HTML and XML turns either off.
(() => {
  const monaco = ide.monaco;
  const CLOSE_TAG = 'editor.htmlCloseTag';
  const CLOSE_SLASH = 'editor.htmlCloseOnSlash';
  const DEFAULTS = { [CLOSE_TAG]: true, [CLOSE_SLASH]: true };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  const NAME = /[A-Za-z_][^\s/>]*/y;
  const NONE = new Set();

  // Where offset `end` falls in an HTML text, scanning from the start: {state, open, tag?}. state is 'text', 'tag' (in
  // a start or end tag, outside attribute values; tag = {name, closing}), 'value' (in a quoted attribute value),
  // 'comment', 'markup' (`<!DOCTYPE`, `<![CDATA[`, `<?…`) or 'raw' (content of a RAW element). open: the names of the
  // elements open at `end`, outermost first, as written; an end tag closes the innermost element of its name.
  // xml: an XML text, where no element is void or raw text.
  // resume ({i, open}, for offsets in increasing order in the same text): where to start, moved on to the last point
  // before `end` that a later offset can start from, so 50 carets in a 5 MB file scan it once rather than 50 times.
  function scan(text, end, xml = false, resume = null) {
    const VOIDS = xml ? NONE : VOID;
    const RAWS = xml ? NONE : RAW;
    const from = resume && resume.i <= end ? resume : null;
    const open = from ? [...from.open] : [];
    let i = from ? from.i : 0;
    let lt = i;
    const stop = (r, at) => { if (resume) Object.assign(resume, { i: at, open: [...open] }); return r; };
    while (i < end) {
      lt = text.indexOf('<', i);
      if (lt < 0 || lt >= end) break;
      i = lt + 1;
      if (text.startsWith('!--', i)) {
        const close = text.indexOf('-->', i + 3);
        if (close < 0 || close + 3 > end) return stop({ state: 'comment', open }, lt);
        i = close + 3;
        continue;
      }
      if (text[i] === '!' || text[i] === '?') {
        const cdata = text.startsWith('![CDATA[', i);
        const close = cdata ? text.indexOf(']]>', i) : text.indexOf('>', i);
        const after = close < 0 ? -1 : close + (cdata ? 3 : 1);
        if (after < 0 || after > end) return stop({ state: 'markup', open }, lt);
        i = after;
        continue;
      }
      const closing = text[i] === '/';
      NAME.lastIndex = i + (closing ? 1 : 0);
      const m = NAME.exec(text);
      if (!m) continue; // a lone `<` is text
      const name = m[0];
      let quote = null;
      let gt = -1;
      for (i = NAME.lastIndex; i < end; i++) {
        const c = text[i];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') { gt = i; break; }
      }
      if (gt < 0) return stop({ state: quote ? 'value' : 'tag', open, tag: { name, closing } }, lt);
      i = gt + 1;
      const lower = name.toLowerCase();
      if (closing) {
        const k = open.findLastIndex((n) => n.toLowerCase() === lower);
        if (k >= 0) open.length = k;
      } else if (text[gt - 1] !== '/' && !VOIDS.has(lower)) {
        if (RAWS.has(lower)) {
          const endTag = new RegExp(`</${lower}(?=[\\s/>])`, 'gi');
          endTag.lastIndex = i;
          const e = endTag.exec(text);
          if (!e || e.index >= end) return stop({ state: 'raw', open: [...open, name] }, lt);
          i = e.index;
          continue;
        }
        open.push(name);
      }
    }
    return stop({ state: 'text', open }, i);
  }

  // The end tag to put after a `>` just typed at offset `gt`, or null.
  function endTagFor(text, gt, xml = false, resume = null) {
    const at = scan(text, gt, xml, resume);
    if (at.state !== 'tag' || at.tag.closing || text[gt - 1] === '/' || (!xml && VOID.has(at.tag.name.toLowerCase()))) return null;
    const close = `</${at.tag.name}`;
    const next = text.slice(gt + 1, gt + 1 + close.length + 1);
    if (next.slice(0, close.length).toLowerCase() === close.toLowerCase() && /^$|[\s>]/.test(next.slice(close.length))) return null;
    return `${close}>`;
  }

  // The rest of the end tag after a `</` just typed (the `/` at offset `slash`), or null. Monaco's XML editing pairs
  // `<` with `>`, so there `</` is followed by that `>`: only the name goes before it ({text, skip: 1} moves the caret
  // past it).
  function endTagNameFor(text, slash, xml = false, resume = null) {
    const paired = xml && text[slash + 1] === '>';
    if (text[slash - 1] !== '<' || (!paired && /^[\w:.-]|^>/.test(text.slice(slash + 1, slash + 2)))) return null;
    const at = scan(text, slash - 1, xml, resume);
    if (at.state !== 'text' && at.state !== 'raw') return null;
    const name = at.open.at(-1);
    if (!name) return null;
    return paired ? { text: name, skip: 1 } : `${name}>`;
  }

  const MARKUP = new Set(['html', 'xml']);
  const isMarkup = (model) => !!model && !model.isDisposed() && MARKUP.has(model.getLanguageId());

  // At every empty selection right after `typed`, inserts what `insertFor(text, offset of typed, xml, resume)` gives (a
  // string, or {text, skip}; the carets go in text order, sharing scan's resume point). The caret stays before an
  // inserted end tag (`stay`) or moves past a completed name, and `skip` characters more; one undo step takes all
  // insertions away.
  function insertAtCarets(ed, typed, insertFor, stay) {
    const model = ed.getModel();
    if (!isMarkup(model) || ed.getOption(monaco.editor.EditorOption.readOnly)) return false;
    const xml = model.getLanguageId() === 'xml';
    const sels = ed.getSelections() || [];
    const text = model.getValue();
    const edits = [];
    const resume = { i: 0, open: [] };
    const empty = sels.filter((s) => s.isEmpty()).map((s) => ({ s, offset: model.getOffsetAt(s.getPosition()) - 1 })).sort((a, b) => a.offset - b.offset);
    for (const { s, offset } of empty) {
      if (text[offset] !== typed) continue;
      const insert = insertFor(text, offset, xml, resume);
      if (insert) edits.push({ line: s.positionLineNumber, column: s.positionColumn, skip: 0, ...(typeof insert === 'string' ? { text: insert } : insert) });
    }
    if (!edits.length) return false;
    // Inserted text has no line breaks, so it shifts only the carets after it on its own line.
    const shift = (line, column, own) => edits.reduce((n, e) => n + (e.line === line && (e.column < column || (own && e.column === column)) ? e.text.length : 0), 0);
    const carets = sels.map((s) => {
      const mine = !stay && s.isEmpty() ? edits.find((e) => e.line === s.positionLineNumber && e.column === s.positionColumn) : null;
      const c = s.positionColumn + shift(s.positionLineNumber, s.positionColumn, !!mine) + (mine?.skip || 0);
      const a = s.selectionStartLineNumber === s.positionLineNumber && s.selectionStartColumn === s.positionColumn ? c
        : s.selectionStartColumn + shift(s.selectionStartLineNumber, s.selectionStartColumn, false);
      return new monaco.Selection(s.selectionStartLineNumber, a, s.positionLineNumber, c);
    });
    ed.pushUndoStop();
    ed.executeEdits('pyide.htmlCloseTag', edits.map((e) => ({ range: new monaco.Range(e.line, e.column, e.line, e.column), text: e.text })), carets);
    ed.pushUndoStop();
    return true;
  }

  const closeStartTag = (ed) => get(CLOSE_TAG) !== false && insertAtCarets(ed, '>', endTagFor, true);
  const completeEndTag = (ed) => get(CLOSE_SLASH) !== false && insertAtCarets(ed, '/', endTagNameFor, false);

  // onDidType fires for typed text only (keys, IME), not for pastes, undo or edits other features make.
  ide.onEditor((ed) => {
    if (typeof ed.onDidType !== 'function') return;
    ed.onDidType((typed) => {
      if (typed.endsWith('>')) closeStartTag(ed);
      else if (typed.endsWith('/')) completeEndTag(ed);
    });
  });

  // Settings › Editor › Smart Keys (the editor-assists page) gets an HTML section; without it, a page of its own.
  const section = {
    defaults: DEFAULTS,
    keywords: 'html tag close closing end tag auto-close xml markup 태그 닫기 닫는 태그 자동',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('HTML and XML'));
      s.appendChild(ctx.ui.checkbox(CLOSE_TAG, tr('Insert closing tag on typing >')));
      s.appendChild(ctx.ui.checkbox(CLOSE_SLASH, tr('Complete the end tag on typing </')));
    },
  };
  (ide.smartKeysSections ||= []).push(section);
  ide.on('ready', () => {
    if ((ide.settingsPages || []).some((p) => p.id === 'smart-keys')) return;
    (ide.settingsPages ||= []).push({ id: 'html-smart-keys', group: 'editor', title: () => tr('Smart Keys'), ...section });
  });

  ide.htmlAutoClose = { scan, endTagFor, endTagNameFor, closeStartTag, completeEndTag, keys: { CLOSE_TAG, CLOSE_SLASH } };
})();
