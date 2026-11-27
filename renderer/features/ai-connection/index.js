// Settings › AI › Connection: how the AI features (AI Chat, AI edits, code generation, Craft's translation and Cut's
// AI) reach a model (main/features/ai-connection.js, main/ai/connection.js).
// - Claude Code: the CLI on this PC, signed in with the user's Claude account (the default).
// - Anthropic API: Claude with the user's API key; each feature's Haiku, Sonnet or Opus is the current model.
// - OpenAI-compatible API: any server with /chat/completions (OpenAI, Gemini, OpenRouter, Ollama on this PC); one model.
// The choice, the address and the model are settings (OK/Apply). A key is saved at once by its own button, kept by
// main with safeStorage, and never comes back to this page: only whether there is one and its last four characters.
(() => {
  const { el } = ide.util;
  const KEYS = { provider: 'aiConnection.provider', openaiUrl: 'aiConnection.openaiUrl', openaiModel: 'aiConnection.openaiModel' };
  const DEFAULT_URL = 'https://api.openai.com/v1';
  const PRESETS = [
    ['https://api.openai.com/v1', 'OpenAI'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'Google Gemini'],
    ['https://openrouter.ai/api/v1', 'OpenRouter'],
    ['http://localhost:11434/v1', 'Ollama (this PC)'],
  ];

  function textInput(ctx, key, placeholder) {
    const i = el('input');
    i.type = 'text';
    i.dataset.key = key;
    i.spellcheck = false;
    i.placeholder = placeholder || '';
    i.value = ctx.value(key) ?? '';
    i.oninput = () => ctx.set(key, i.value.trim());
    return i;
  }

  // The key row of one provider: a password field, Save and Remove, and what is kept now.
  function keyRow(provider, st, refresh) {
    const box = el('div', 'aic-key');
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.aicKey = provider;
    const save = el('button', 'btn', tr('Save Key'));
    save.dataset.aicSave = provider;
    const remove = el('button', 'btn', tr('Remove'));
    remove.dataset.aicRemove = provider;
    const show = (s) => {
      const kept = s.keys[provider];
      input.placeholder = kept.has ? tr('Saved key ending in {end}', { end: kept.end }) : provider === 'openai' ? tr('Not needed for Ollama on this PC') : 'sk-ant-…';
      remove.disabled = !kept.has;
    };
    show(st);
    const note = el('div', 'muted settings-note aic-key-note');
    const set = async (value) => {
      const r = await ide.api.invoke('ai-connection:setKey', provider, value);
      input.value = '';
      note.textContent = !r?.ok ? tr('The key could not be saved.') : r.kept === 'memory' ? tr('Windows cannot encrypt it here, so the key is kept until Nano Studio closes.') : r.kept === 'disk' ? tr('Saved. Only this Windows account can read it.') : tr('Removed.');
      if (r?.status) { show(r.status); refresh(r.status); }
    };
    save.onclick = () => { if (input.value.trim()) set(input.value); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) set(input.value); } };
    remove.onclick = () => set('');
    box.append(input, save, remove);
    return [box, note];
  }

  (ide.settingsPages ||= []).push({
    id: 'ai-connection', group: 'ai', craft: true, title: () => tr('Connection'),
    keywords: 'ai api key anthropic openai gemini ollama openrouter claude code connection model provider 연결 키 공급자 모델 주소',
    defaults: { [KEYS.provider]: 'claude-code', [KEYS.openaiUrl]: DEFAULT_URL, [KEYS.openaiModel]: '' },
    async mount(host, ctx) {
      const sec = ctx.ui.section(host, tr('AI Connection'));
      const provider = ctx.ui.selectInput(KEYS.provider, [
        ['claude-code', tr('Claude Code (your Claude account)')],
        ['anthropic', tr('Anthropic API (API key)')],
        ['openai', tr('OpenAI-compatible API (OpenAI, Gemini, OpenRouter, Ollama…)')],
      ], 'claude-code');
      sec.appendChild(ctx.ui.fieldRow(tr('Use:'), provider));
      const body = el('div', 'aic-body');
      sec.appendChild(body);
      let st = await ide.api.invoke('ai-connection:status');

      const testRow = el('div', 'aic-test');
      const testBtn = el('button', 'btn', tr('Test Connection'));
      testBtn.dataset.aicTest = '';
      const testOut = el('span', 'muted aic-test-out');
      testRow.append(testBtn, testOut);
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testOut.textContent = tr('Asking…');
        const cfg = { provider: ctx.value(KEYS.provider), openaiUrl: ctx.value(KEYS.openaiUrl), openaiModel: ctx.value(KEYS.openaiModel) };
        const r = await ide.api.invoke('ai-connection:test', cfg);
        testBtn.disabled = false;
        testOut.textContent = r.ok ? tr('It answered in {s} s ({model}).', { s: (r.ms / 1000).toFixed(1), model: r.model }) : explain(r);
        testOut.classList.toggle('aic-bad', !r.ok);
      };

      function draw() {
        body.replaceChildren();
        testOut.textContent = '';
        const which = ctx.value(KEYS.provider) || 'claude-code';
        if (which === 'claude-code') {
          body.append(el('div', 'muted settings-note', tr('Requests go through the Claude Code CLI on this PC, signed in with your Claude account (Pro, Max or Console). Usage counts against that account.')));
          return;
        }
        if (which === 'anthropic') {
          const [row, note] = keyRow('anthropic', st, (s) => { st = s; });
          body.append(ctx.ui.fieldRow(tr('API key:'), row), note,
            el('div', 'muted settings-note', tr('Create a key at console.anthropic.com. Each feature\'s model setting picks Claude Haiku, Sonnet or Opus (the current version of each). Usage is billed to your API account.')));
        } else {
          const url = textInput(ctx, KEYS.openaiUrl, DEFAULT_URL);
          const preset = el('select', 'aic-preset');
          preset.add(new Option(tr('Presets…'), ''));
          for (const [v, label] of PRESETS) preset.add(new Option(label, v));
          preset.onchange = () => { if (preset.value) { url.value = preset.value; ctx.set(KEYS.openaiUrl, preset.value); } preset.value = ''; };
          const urlBox = el('div', 'aic-url');
          urlBox.append(url, preset);
          const model = textInput(ctx, KEYS.openaiModel, 'gpt-5.1, gemini-2.5-flash, llama3.2…');
          const [row, note] = keyRow('openai', st, (s) => { st = s; });
          body.append(ctx.ui.fieldRow(tr('Address:'), urlBox), ctx.ui.fieldRow(tr('Model:'), model), ctx.ui.fieldRow(tr('API key:'), row), note,
            el('div', 'muted settings-note', tr('Every AI feature uses this one model. The server must support /chat/completions with streaming; Cut\'s AI assistant also needs tool calls.')));
        }
        if (!st.safeStorage) body.append(el('div', 'muted settings-note', tr('Windows cannot encrypt keys for this account: a key is kept only until Nano Studio closes.')));
        body.append(testRow, el('div', 'muted settings-note', tr('Test Connection sends one short request (a few tokens). Cut windows that are already open keep the connection they started with.')));
      }
      provider.addEventListener('change', draw);
      draw();
    },
  });

  // A failed request's reason for an API: the features call this for res.via === 'api'.
  function explain(res) {
    if (res.code === 'setup') return tr('The API is not set up yet: {error}', { error: res.message || res.error || '' });
    if (res.code === 'auth') return tr('The API refused the key. Check it in Settings › AI › Connection.');
    if (res.code === 'quota') return tr('The API\'s rate or spending limit was reached: {error}', { error: res.message || res.error || '' });
    if (res.code === 'timeout') return tr('The API did not answer in time.');
    if (res.code === 'claude-code') return tr('Claude Code is chosen: there is no API to test.');
    return tr('The API request failed: {error}', { error: res.message || res.error || '' });
  }

  ide.aiConnection = {
    explain,
    status: () => ide.api.invoke('ai-connection:status'),
    open: () => ide.openSettings?.('ai-connection'),
  };
})();
