// Errors on demand, from this plugin's own code: an uncaught exception in a timer and an unhandled rejection.
(() => {
  function failLater() {
    setTimeout(function flakyTimer() { throw new Error('diag-flaky: renderer failure'); }, 0);
  }
  ide.registerAction({ id: 'DiagFlaky.Fail', title: 'Diag Flaky Fail', run: failLater });
  ide.registerAction({ id: 'DiagFlaky.Reject', title: 'Diag Flaky Reject', run: () => { Promise.reject(new Error('diag-flaky: rejected promise')); } });
})();
