// Loaded first in every window (main and detached): uncaught errors, unhandled rejections, scripts that fail to load
// and console.error(…, err) go to the main process, which logs them and lists them as IDE internal errors with the
// plugin they came from (main/diagnostics). console.warn/error text also goes to the IDE log.
// window.ideDiagnostics.logger(category) -> {debug, info, warn, error} writes to the log (also ide.log / ide.logger).
(() => {
  const windowKind = new URLSearchParams(location.search).has('detached') ? 'detached' : 'main';
  const send = (channel, payload) => { try { api.send(channel, payload); } catch {} };
  const text = (v) => {
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const report = (payload) => send('diagnostics:report', { window: windowKind, ...payload });
  // Monaco cancels in-flight provider requests and leaves the rejection unhandled; these are not errors. Nor is a diff
  // editor's diff whose models were disposed while the worker computed it (Monaco 0.57 reports that as "no diff result
  // available" once the diff view is already gone).
  const isCanceled = (r) => (r?.name === 'Canceled' && r?.message === 'Canceled') || (r instanceof Error && r.message.startsWith('no diff result available'));
  // ResizeObserver's loop notice is not an exception: the browser reports it when some size notifications wait for the
  // next frame, and nothing is lost. It goes to the log once per window instead of the internal errors list.
  const RO_NOTICE = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
  let roNoticeLogged = false;
  // Plugins whose index.js could not be read or threw while it ran (id -> reason), for the Plugins page. Each is
  // reported once, as main reports a main module that fails to load. The plugin's <script> (core's loadFeatures) carries
  // data-plugin and data-plugin-name; an error event while it runs has it as document.currentScript.
  const pluginLoadErrors = new Map();
  const pluginFailed = (script, reason, stack) => {
    const { plugin, pluginName } = script.dataset;
    if (pluginLoadErrors.has(plugin)) return;
    pluginLoadErrors.set(plugin, reason.split('\n')[0]);
    report({ kind: 'load', message: `Plugin ${pluginName} failed to load (index.js): ${reason}`, stack });
  };

  addEventListener('error', (e) => {
    // A <script> or stylesheet that failed to load (a plugin's index.js, for example).
    // Images and media that fail (a broken picture in Markdown) are content, not IDE errors.
    if (e.target && e.target !== window) {
      const src = e.target.src || e.target.href;
      if (src && e.target.dataset?.plugin) pluginFailed(e.target, 'the file could not be read', `    at ${src}:1:1`);
      else if (src && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) report({ kind: 'load', message: `Failed to load ${src}`, stack: `    at ${src}:1:1` });
      return;
    }
    const err = e.error;
    if (isCanceled(err)) return void e.preventDefault();
    if (document.currentScript?.dataset.plugin) {
      const reason = err?.message || e.message || 'Script error';
      return void pluginFailed(document.currentScript, reason, `${err?.stack || reason}\n    at ${e.filename}:${e.lineno}:${e.colno}`);
    }
    if (!err && RO_NOTICE.test(e.message || '')) {
      if (!roNoticeLogged) send('diagnostics:log', { level: 'WARN', category: `#renderer.${windowKind}`, message: `${e.message} (logged once per window)` });
      roNoticeLogged = true;
      return;
    }
    const message = err?.message || e.message || 'Script error';
    report({ kind: 'uncaught', message, stack: err?.stack || `${message}\n    at ${e.filename}:${e.lineno}:${e.colno}` });
  }, true);

  addEventListener('unhandledrejection', (e) => {
    if (isCanceled(e.reason)) return void e.preventDefault();
    const r = e.reason;
    const message = r instanceof Error || r?.message ? `${r.name || 'Error'}: ${r.message}` : `Unhandled promise rejection: ${text(r)}`;
    report({ kind: 'rejection', message, stack: r?.stack || message });
  });

  const logger = (category = '#renderer') => {
    const at = (level) => (...args) => send('diagnostics:log', { level, category, message: args.map(text).join(' ') });
    return { debug: at('DEBUG'), info: at('INFO'), warn: at('WARN'), error: at('ERROR') };
  };

  for (const [method, level] of [['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const err = args.find((a) => a instanceof Error);
      if (level === 'ERROR' && err && !isCanceled(err)) {
        report({ kind: 'logged', message: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : text(a))).join(' '), stack: err.stack });
      } else send('diagnostics:log', { level: err && isCanceled(err) ? 'DEBUG' : level, category: `#renderer.${windowKind}`, message: args.map(text).join(' ') });
    };
  }

  window.ideDiagnostics = {
    logger,
    pluginLoadErrors,
    // For errors a plugin catches but still wants listed as internal errors.
    report: (error, message) => report({ kind: 'reported', message: message || error?.message || String(error), stack: error?.stack || String(error) }),
  };
})();
