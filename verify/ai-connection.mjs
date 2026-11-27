// Settings › AI › Connection (renderer/features/ai-connection, main/ai/connection.js) in the app: choosing the Anthropic
// API or an OpenAI-compatible one, a key saved with safeStorage (never in settings.json, never back in the page), Test
// Connection, AI Chat answered over the API, a refused key explained with a way to the settings, Claude Code again,
// and the page in Craft. Stand-in APIs on 127.0.0.1 (PYIDE_ANTHROPIC_URL); nothing reaches a real API.
// Ports 9703 (Code), 9704 (Craft).
import http from 'http';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const S = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'sk-ant-test-0000-WXYZ';
const asked = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { asked.push({ url: req.url, headers: req.headers, body: JSON.parse(body || 'null') }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const stream = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : S(e)}\n\n`);
  res.end();
};
const anthropic = await listen((req, res) => {
  if (req.headers['x-api-key'] !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(S({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
  stream(res, [{ type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'API ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }]);
});
const openai = await listen((req, res) => stream(res, [{ choices: [{ index: 0, delta: { content: 'OK from llama' } }] }, '[DONE]']));

const t = await launch({ fixture: 'ai-chat', port: 9703, name: 'ai-connection', env: { PYIDE_ANTHROPIC_URL: `${anthropic.url}/v1`, PYIDE_CLAUDE_PATH: 'none' } });
const { js, until, check, click, cdp } = t;
const settles = (expr, label, ms = 8000) => until(expr, label, ms).then(() => true, () => false);
const q = (sel) => `document.querySelector(${S(sel)})`;
async function pick(sel, value) {
  await js(`(() => { const s = ${q(sel)}; s.value = ${S(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
}
async function typeInto(sel, text) {
  await click(sel);
  await js(`${q(sel)}.focus()`);
  await cdp('Input.insertText', { text });
  await sleep(100);
}
const keysFile = path.join(t.userData, 'ai-connection', 'keys.json');
const settingsText = () => { try { return readFileSync(path.join(t.userData, 'settings.json'), 'utf8'); } catch { return ''; } };

try {
  await js(`ide.openSettings('ai-connection')`);
  check(await settles(`!!${q('[data-key="aiConnection.provider"]')}`, 'the Connection page'), 'Settings › AI › Connection opens');
  check(await js(`${q('[data-key="aiConnection.provider"]')}.value === 'claude-code' && !${q('[data-aic-key]')}`), 'Claude Code is the default, with no key field');

  // ---------- the Anthropic API ----------
  await pick('[data-key="aiConnection.provider"]', 'anthropic');
  check(await settles(`!!${q('[data-aic-key="anthropic"]')}`, 'key field'), 'choosing the Anthropic API shows its key field');
  await typeInto('[data-aic-key="anthropic"]', KEY);
  await click('[data-aic-save="anthropic"]');
  check(await settles(`${q('[data-aic-key="anthropic"]')}.value === '' && ${q('[data-aic-key="anthropic"]')}.placeholder.includes('WXYZ')`, 'saved'), 'Save Key: the field empties and shows the key\'s last four characters');
  check(await js(`${q('.aic-key-note')}.textContent.includes('Only this Windows account')`), 'it says the key is kept for this Windows account');
  const kept = existsSync(keysFile) ? readFileSync(keysFile, 'utf8') : '';
  check(!!JSON.parse(kept || '{}').anthropic && !kept.includes(KEY) && !kept.includes('WXYZ'), 'keys.json holds the key encrypted, not the text');
  check(!settingsText().includes(KEY), 'settings.json never holds the key');
  const status = await js(`ide.api.invoke('ai-connection:status')`);
  check(!S(status).includes(KEY) && status.keys.anthropic.has && status.keys.anthropic.end === 'WXYZ', `the page gets back only that there is a key and its end (${S(status.keys)})`);

  await click('[data-aic-test]');
  check(await settles(`${q('.aic-test-out')}.textContent.includes('It answered')`, 'test', 15000), `Test Connection, before Apply, asks the chosen API (${await js(`${q('.aic-test-out')}.textContent`)})`);
  const test = asked.at(-1);
  check(test.headers['x-api-key'] === KEY && test.body.model === 'claude-haiku-5-5', 'the test is one small Haiku request with the saved key');
  await click('#settingsOk');
  check(await settles(`!${q('[data-key="aiConnection.provider"]')}`, 'closed'), 'OK closes the dialog');
  check(JSON.parse(settingsText() || '{}')['aiConnection.provider'] === 'anthropic', 'the choice is saved as a setting');

  // ---------- AI Chat over the API ----------
  const before = asked.length;
  await js(`(ide.aiChat.open(), ide.aiChat.send('hello over the API'), true)`);
  check(await settles(`ide.aiChat.state().messages.at(-1)?.text === 'API answer' && !ide.aiChat.state().messages.at(-1).pending`, 'chat reply', 20000), 'AI Chat answers over the Anthropic API, though Claude Code is not installed');
  const chat = asked.slice(before).at(-1);
  check(chat?.body.model === 'claude-sonnet-5-5' && chat.body.messages[0].content.includes('hello over the API'), `the chat's Sonnet is claude-sonnet-5-5 (${chat?.body.model})`);

  // ---------- a refused key ----------
  await js(`ide.api.invoke('ai-connection:setKey', 'anthropic', 'sk-ant-wrong')`);
  await js(`ide.aiChat.send('again')`);
  check(await settles(`!!ide.aiChat.state().messages.at(-1)?.error`, 'error', 20000), 'a refused key ends the reply with an error');
  const err = await js(`ide.aiChat.state().messages.at(-1).error`);
  check(/refused the key/.test(err) && !/Claude Code/.test(err), `it says the API refused the key, not that Claude Code is signed out (${err})`);
  check(await settles(`[...document.querySelectorAll('.aic-login')].some((b) => b.textContent.includes('AI Connection'))`, 'button'), 'the error offers Open AI Connection Settings');

  // ---------- an OpenAI-compatible API ----------
  await js(`ide.openSettings('ai-connection')`);
  await settles(`!!${q('[data-key="aiConnection.provider"]')}`, 'page again');
  await pick('[data-key="aiConnection.provider"]', 'openai');
  check(await settles(`!!${q('[data-key="aiConnection.openaiUrl"]')} && !!${q('[data-key="aiConnection.openaiModel"]')}`, 'openai fields'), 'an OpenAI-compatible API asks for its address and model');
  await js(`(() => { const u = ${q('[data-key="aiConnection.openaiUrl"]')}; u.value = ${S(`${openai.url}/v1`)}; u.dispatchEvent(new Event('input')); const m = ${q('[data-key="aiConnection.openaiModel"]')}; m.value = 'llama3.2'; m.dispatchEvent(new Event('input')); })()`);
  await click('[data-aic-test]');
  check(await settles(`${q('.aic-test-out')}.textContent.includes('llama3.2')`, 'openai test', 15000), `Test Connection reaches the address with the model, no key needed (${await js(`${q('.aic-test-out')}.textContent`)})`);
  const o = asked.at(-1);
  check(o.url === '/v1/chat/completions' && o.body.model === 'llama3.2' && !o.headers.authorization, 'an OpenAI-compatible request: /chat/completions, the model set, no key');

  // ---------- back to Claude Code ----------
  await pick('[data-key="aiConnection.provider"]', 'claude-code');
  await click('#settingsOk');
  await settles(`!${q('[data-key="aiConnection.provider"]')}`, 'closed again');
  const n = asked.length;
  await js(`ide.aiChat.send('with Claude Code')`);
  check(await settles(`!!ide.aiChat.state().messages.at(-1)?.error`, 'cc error', 20000), 'with Claude Code chosen again the chat uses the CLI');
  check(asked.length === n && /Claude Code is not installed/.test(await js(`ide.aiChat.state().messages.at(-1).error`)), 'no API request, and the missing CLI is explained as before');
  check(!(await js(`document.body.innerText`)).includes(KEY), 'the key is shown nowhere');
} catch (err) {
  check(false, `ai-connection crashed: ${err.stack || err}`);
} finally {
  t.close();
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
}

// ---------- Craft has the page ----------
const c = await launch({ fixture: 'ai-chat', port: 9704, name: 'ai-connection-craft', mode: 'craft' });
try {
  c.check(await c.js(`ide.settingsPageList().some((p) => p.id === 'ai-connection')`), 'Craft\'s settings have AI › Connection (its translation uses it)');
} catch (err) {
  c.check(false, `craft part crashed: ${err.stack || err}`);
} finally {
  c.close();
}
anthropic.server.close();
openai.server.close();
const failed = [...t.results, ...c.results].filter((r) => !r.ok).length;
console.log(`\n${[...t.results, ...c.results].length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
