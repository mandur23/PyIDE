// The status bar's line separator widget, as in PyCharm: LF / CRLF / CR for the current file, between the caret position
// and the encoding (it always shows, like them), and a menu that converts the whole file. The core (editors.js) owns the
// separator itself: it detects it on load (doc.lineSeparator, doc.mixedSeparators), keeps it on save, and gives new
// files the Settings › Editor › Code Style choice. A conversion is one undo step and marks the file modified.
(() => {
  const { el } = ide.util;
  const LF = '\n', CRLF = '\r\n', CR = '\r';
  const NAME = { [LF]: 'LF', [CRLF]: 'CRLF', [CR]: 'CR' };
  const LABEL = () => ({ [LF]: tr('LF - Unix and macOS (\\n)'), [CRLF]: tr('CRLF - Windows (\\r\\n)'), [CR]: tr('CR - Classic Mac OS (\\r)') });
  const { LF: EOL_LF, CRLF: EOL_CRLF } = ide.monaco.editor.EndOfLineSequence;

  const item = el('button', 'lsep-status');
  item.id = 'statusLineSeparator';
  item.hidden = true;
  const encoding = document.getElementById('statusEncoding');
  if (encoding) encoding.before(item); else ide.registerStatusItem({ order: 99, el: item });

  const activeDoc = () => {
    const doc = ide.activeTab()?.doc;
    return doc && !doc.model.isDisposed() && doc.lineSeparator ? doc : null;
  };

  function render() {
    const doc = activeDoc();
    item.hidden = !doc;
    if (!doc) return;
    const name = NAME[doc.lineSeparator];
    item.textContent = name;
    item.dataset.separator = name;
    item.classList.toggle('lsep-mixed', !!doc.mixedSeparators);
    item.title = [tr('Line separator: {name}', { name }),
      doc.mixedSeparators ? tr('The file has mixed line separators. Saving it writes {name} everywhere.', { name }) : '',
      tr('Click to change')].filter(Boolean).join('\n');
  }

  // The separator each version of a model had, so Undo and Redo of a conversion bring the old one back. Monaco's
  // alternative version id returns to the old number on undo.
  const history = new WeakMap(); // doc -> Map(alternativeVersionId -> {sep, mixed})
  function track(doc) {
    let map = history.get(doc);
    if (map) return map;
    map = new Map();
    history.set(doc, map);
    // Every change is looked up: Monaco reports the EOL change of an undo without isUndoing.
    doc.model.onDidChangeContent(() => {
      const s = map.get(doc.model.getAlternativeVersionId());
      if (!s || (s.sep === doc.lineSeparator && s.mixed === !!doc.mixedSeparators)) return;
      Object.assign(doc, { lineSeparator: s.sep, mixedSeparators: s.mixed });
      if (ide.activeTab()?.doc === doc) render();
    });
    return map;
  }

  // Converts the whole document; one undo step. Monaco's model holds LF or CRLF (CR files are CRLF in it), so CR <-> CRLF
  // and making a mixed file uniform change nothing in the model: an edit that puts the first character (or line break)
  // back makes the step and the modified mark.
  function convert(doc, sep) {
    if (!doc || doc.model.isDisposed() || (doc.lineSeparator === sep && !doc.mixedSeparators)) return false;
    const model = doc.model;
    const map = track(doc);
    const before = model.getAlternativeVersionId();
    if (!map.has(before)) map.set(before, { sep: doc.lineSeparator, mixed: !!doc.mixedSeparators });
    const eol = sep === LF ? LF : CRLF;
    model.pushStackElement();
    if (model.getEOL() !== eol) model.pushEOL(eol === LF ? EOL_LF : EOL_CRLF);
    else {
      const { Range } = ide.monaco;
      const line = model.getLinesContent().findIndex((l) => l.length) + 1;
      const range = line ? new Range(line, 1, line, 2) : model.getLineCount() > 1 ? new Range(1, 1, 2, 1) : null;
      if (range) model.pushEditOperations(null, [{ range, text: model.getValueInRange(range) }], () => null);
    }
    model.pushStackElement();
    Object.assign(doc, { lineSeparator: sep, mixedSeparators: false });
    map.set(model.getAlternativeVersionId(), { sep, mixed: false });
    ide.renderTabs();
    ide.emit('lineSeparatorChanged', doc);
    return true;
  }

  function showMenu() {
    const doc = activeDoc();
    if (!doc) return;
    const r = item.getBoundingClientRect();
    const labels = LABEL();
    const menu = ide.ui.contextMenu(r.left, r.top - 4, [
      { header: tr('Line Separator') },
      ...[LF, CRLF, CR].map((sep) => ({ label: labels[sep], checked: doc.lineSeparator === sep, run: () => convert(doc, sep) })),
    ]);
    menu.id = 'lineSeparatorMenu';
    menu.style.top = `${Math.max(4, r.top - menu.offsetHeight - 4)}px`;
  }
  item.onclick = (e) => { e.stopPropagation(); showMenu(); };

  ide.on('activeTabChanged', render);
  ide.on('lineSeparatorChanged', (doc) => { if (!doc || ide.activeTab()?.doc === doc) render(); });
  ide.on('fileSaved', render);
  render();

  // PyCharm's File › File Properties › Line Separators actions (Find Action).
  for (const [id, sep] of [['ConvertToUnixLineSeparators', LF], ['ConvertToWindowsLineSeparators', CRLF], ['ConvertToMacLineSeparators', CR]]) {
    ide.registerAction({ id, title: LABEL()[sep], when: () => !!activeDoc(), run: () => convert(activeDoc(), sep) });
  }

  ide.lineSeparators.convert = convert;
  ide.lineSeparators.name = (sep) => NAME[sep];
})();
