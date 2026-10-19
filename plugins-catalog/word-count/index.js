(() => {
  const item = ide.util.el('span', 'word-count-status');
  item.id = 'wordCountStatus';
  ide.registerStatusItem({ order: 5, el: item });

  function update() {
    const model = ide.editor.getModel();
    if (!model) { item.textContent = ''; return; }
    const sel = ide.editor.getSelection();
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

  ide.on('ready', () => {
    ide.editor.onDidChangeModel(update);
    ide.editor.onDidChangeModelContent(update);
    ide.editor.onDidChangeCursorSelection(update);
    update();
  });
})();
