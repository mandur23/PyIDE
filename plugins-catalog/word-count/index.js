(() => {
  const item = ide.util.el('span', 'word-count-status');
  item.id = 'wordCountStatus';
  ide.registerStatusItem({ order: 5, el: item });

  // Counts for the active pane's editor.
  function update() {
    const ed = ide.editor;
    const model = ed?.getModel();
    if (!model) { item.textContent = ''; return; }
    const sel = ed.getSelection();
    const text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue();
    const vars = {
      lines: text ? text.split(/\r?\n/).length : 0,
      words: (text.match(/[\p{L}\p{N}_]+/gu) || []).length,
      chars: text.length,
    };
    item.textContent = sel && !sel.isEmpty()
      ? tr('Selection: {lines} lines, {words} words, {chars} chars', vars)
      : tr('{lines} lines, {words} words, {chars} chars', vars);
  }

  const updateIfActive = (ed) => () => { if (ed === ide.editor) update(); };
  ide.onEditor((ed) => {
    ed.onDidChangeModel(updateIfActive(ed));
    ed.onDidChangeModelContent(updateIfActive(ed));
    ed.onDidChangeCursorSelection(updateIfActive(ed));
  });
  ide.on('activeEditorChanged', update);
  ide.on('ready', update);
})();
