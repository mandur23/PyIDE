// Fails while activating, like a plugin built against an API that no longer exists.
(() => {
  ide.registerAction({ id: 'DiagBroken.Never', title: 'Never registered', run() {} });
  ide.noSuchApi.register();
})();
