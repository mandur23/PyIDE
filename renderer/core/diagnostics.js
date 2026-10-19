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
  // Monaco cancels in-flight provider requests and leaves the rejection unhandled; these are not errors.
  const isCanceled = (r) => r?.name === 'Canceled' && r?.message === 'Canceled';

  addEventListener('error', (e) => {
    // A <script> or stylesheet that failed to load (a plugin's index.js, for example).
    // Images and media that fail (a broken picture in Markdown) are content, not IDE errors.
    if (e.target && e.target !== window) {
      const src = e.target.src || e.target.href;
      if (src && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) report({ kind: 'load', message: `Failed to load ${src}`, stack: `    at ${src}:1:1` });
      return;
    }
    const err = e.error;
    if (isCanceled(err)) return;
    const message = err?.message || e.message || 'Script error';
    report({ kind: 'uncaught', message, stack: err?.stack || `${message}\n    at ${e.filename}:${e.lineno}:${e.colno}` });
  }, true);

  addEventListener('unhandledrejection', (e) => {
    if (isCanceled(e.reason)) return;
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
      } else send('diagnostics:log', { level, category: `#renderer.${windowKind}`, message: args.map(text).join(' ') });
    };
  }

  window.ideDiagnostics = {
    logger,
    // For errors a plugin catches but still wants listed as internal errors.
    report: (error, message) => report({ kind: 'reported', message: message || error?.message || String(error), stack: error?.stack || String(error) }),
  };
})();
