// Settings › AI › Connection (renderer/features/ai-connection): how the AI features reach a model, the API keys kept
// with safeStorage (main/ai/connection.js) and a test request. The renderer sends a key once, when it is saved, and
// gets back only whether there is one and its last four characters.
const connection = require('../ai/connection');
const api = require('../ai/api');

exports.register = ({ ipcMain }) => {
  ipcMain.handle('ai-connection:status', () => connection.status());
  ipcMain.handle('ai-connection:setKey', (_e, provider, key) => {
    if (typeof key !== 'string' || key.length > 1000) return { ok: false };
    return { ...connection.setKey(provider, key), status: connection.status() };
  });
  // One short request on the chosen API (the user's button; it costs a few tokens). -> {ok, ms, text} | {ok: false, code, message}
  // pending: the page's choice before OK/Apply ({provider, openaiUrl, openaiModel}), with the saved key of that provider.
  ipcMain.handle('ai-connection:test', async (_e, pending) => {
    const cfg = connection.current(pending && typeof pending === 'object' ? pending : undefined);
    if (!cfg) return { ok: false, code: 'claude-code', message: '' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await api.complete(cfg, { system: 'Answer with the single word OK.', prompt: 'Say OK.', model: 'haiku', signal: ctl.signal });
      return { ok: true, ms: r.ms, text: r.text.trim().slice(0, 200), model: api.modelOf(cfg, 'haiku') };
    } catch (err) {
      return { ok: false, code: ctl.signal.aborted && err.code === 'cancelled' ? 'timeout' : err.code || 'cli', message: err.message };
    } finally { clearTimeout(timer); }
  });
};
