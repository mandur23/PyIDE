// Interim diagnostics via ast.parse; the language-server feature supersedes this.
(() => {
  async function check(tab) {
    if (tab?.kind !== 'file' || !tab.path.endsWith('.py')) return;
    const interp = ide.currentInterp();
    if (!interp) return;
    const errs = await ide.api.invoke('py:check', interp, tab.model.getValue());
    ide.problems.set('syntax', tab.path, errs.map((e) => ({ line: e.line, col: e.col, endLine: e.endLine, endCol: e.endCol, msg: e.msg, severity: 'error' })));
  }
  ide.on('fileSaved', check);
  ide.on('fileOpened', check);
  ide.on('fileClosed', (path) => ide.problems.set('syntax', path, []));
})();
