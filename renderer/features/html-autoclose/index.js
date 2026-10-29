// HTML tag closing, as PyCharm and VS Code do it: typing the `>` that ends a start tag puts its end tag after the caret
// (`<h1>|</h1>`), and typing `</` completes the end tag of the innermost open element (`</h1>|`). Each insertion is its
// own undo step. Not for void elements, `<x/>`, a start tag whose end tag already follows the caret, or a `>` typed in
// a comment, an attribute value, `<!DOCTYPE …>` or the content of script, style, textarea and title (where `</`
// completes that element's own end tag). Settings › Editor › Smart Keys › HTML turns either off.
(() => {
  const monaco = ide.monaco;
  const CLOSE_TAG = 'editor.htmlCloseTag';
  const CLOSE_SLASH = 'editor.htmlCloseOnSlash';
  const DEFAULTS = { [CLOSE_TAG]: true, [CLOSE_SLASH]: true };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']);
  const NAME = /[A-Za-z][^\s/>]*/y;

  // Where offset `end` falls in an HTML text, scanning from the start: {state, open, tag?}. state is 'text', 'tag' (in
  // a start or end tag, outside attribute values; tag = {name, closing}), 'value' (in a quoted attribute value),
  // 'comment', 'markup' (`<!DOCTYPE`, `<![CDATA[`, `<?…`) or 'raw' (content of a RAW element). open: the names of the
  // elements open at `end`, outermost first, as written; an end tag closes the innermost element of its name.
  function scan(text, end) {
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
        const cdata = text.startsWith('![CDATA[', i);
        const close = cdata ? text.indexOf(']]>', i) : text.indexOf('>', i);
        const after = close < 0 ? -1 : close + (cdata ? 3 : 1);
        if (after < 0 || after > end) return { state: 'markup', open };
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
      if (gt < 0) return { state: quote ? 'value' : 'tag', open, tag: { name, closing } };
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
          if (!e || e.index >= end) return { state: 'raw', open: [...open, name] };
          i = e.index;
          continue;
        }
        open.push(name);
      }
    }
    return { state: 'text', open };
  }

  // The end tag to put after a `>` just typed at offset `gt`, or null.
  function endTagFor(text, gt) {
    const at = scan(text, gt);
    if (at.state !== 'tag' || at.tag.closing || text[gt - 1] === '/' || VOID.has(at.tag.name.toLowerCase())) return null;
    const close = `</${at.tag.name}`;
    const next = text.slice(gt + 1, gt + 1 + close.length + 1);
    if (next.slice(0, close.length).toLowerCase() === close.toLowerCase() && /^$|[\s>]/.test(next.slice(close.length))) return null;
    return `${close}>`;
  }

  // The rest of the end tag after a `</` just typed (the `/` at offset `slash`), or null.
  function endTagNameFor(text, slash) {
    if (text[slash - 1] !== '<' || /^[\w:.-]|^>/.test(text.slice(slash + 1, slash + 2))) return null;
    const at = scan(text, slash - 1);
    if (at.state !== 'text' && at.state !== 'raw') return null;
    const name = at.open.at(-1);
    return name ? `${name}>` : null;
  }

  const isHtml = (model) => !!model && !model.isDisposed() && model.getLanguageId() === 'html';

  // At every empty selection right after `typed`, inserts what `insertFor(text, offset of typed)` gives. The caret
  // stays before an inserted end tag (`stay`) or moves past a completed name; one undo step takes all insertions away.
  function insertAtCarets(ed, typed, insertFor, stay) {
    const model = ed.getModel();
    if (!isHtml(model) || ed.getOption(monaco.editor.EditorOption.readOnly)) return false;
    const sels = ed.getSelections() || [];
    const text = model.getValue();
    const edits = [];
    for (const s of sels) {
      if (!s.isEmpty()) continue;
      const offset = model.getOffsetAt(s.getPosition()) - 1;
      if (text[offset] !== typed) continue;
      const insert = insertFor(text, offset);
      if (insert) edits.push({ line: s.positionLineNumber, column: s.positionColumn, text: insert });
    }
    if (!edits.length) return false;
    // Inserted text has no line breaks, so it shifts only the carets after it on its own line.
    const shift = (line, column, own) => edits.reduce((n, e) => n + (e.line === line && (e.column < column || (own && e.column === column)) ? e.text.length : 0), 0);
    const carets = sels.map((s) => {
      const own = !stay && s.isEmpty() && edits.some((e) => e.line === s.positionLineNumber && e.column === s.positionColumn);
      const c = s.positionColumn + shift(s.positionLineNumber, s.positionColumn, own);
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
      const s = ctx.ui.section(host, 'HTML');
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
