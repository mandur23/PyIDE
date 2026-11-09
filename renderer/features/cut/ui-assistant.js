// The AI assistant and the control API in the page (docs/cut-ai-control.md, docs/cut-architecture.md section 10).
//
// - The bridge: the tools of Cut.control are listed with main (cut:controlTools) and every call main forwards
//   (cut:controlCall, from the assistant's Claude or an external AI) runs here, one at a time, on Cut.app, and is
//   answered (cut:controlResult). Each edit that lands is shown at once: its sequence comes to the front, the clips it
//   changed flash on the timeline (Cut.ui.timeline.flash) and the playhead moves to it.
// - The AI Assistant panel ('assistant', the Window menu and the Automation menu): a chat. A request runs one Claude
//   Code turn (cut:agentRun, main/cut/agent.js) allowed the Cut tools only; its stream-json events (cut:agentEvent)
//   show what Claude says and each tool call as a step that turns done or refused. Stop ends the turn at once. The
//   edits of a turn are one undo step named after the request (history.squash), each of them a step while it runs.
//   A call of a turn that has ended is refused, and a turn's undo cannot reach the steps before it.
// - External AIs (the setting cut.control.external, off by default): the settings section turns the external token on
//   and shows how to connect (`claude mcp add` and a JSON config, with Copy); while one is connected a banner says so
//   and its Disconnect replaces the token. Their edits show live the same way and are listed in the panel.
// Errors of Claude Code (missing, signed out, out of quota) are explained by ui.ai.explain.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const K = Cut.control;
  const { el, button } = ui;
  const log = ide.logger('#cut');
  const invoke = (...args) => ide.api.invoke(...args);
  const DEFAULTS = { 'cut.control.external': false, 'cut.assistant.acknowledged': false };
  const setting = (k) => { const v = ide.settings.get(k, DEFAULTS[k]); return v === undefined || v === null ? DEFAULTS[k] : v; };
  const T = () => Cut.time.TICKS;
  const HISTORY_TURNS = 6;

  // ---------- services the tools use ----------
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const services = {
    effects: Cut.effects,
    async frame(seq, t, width) {
      if (!Cut.export?.framePng) return { ok: false, error: 'the export engine is not loaded' };
      const app = Cut.app;
      const track = seq.id === app.sequenceId ? ui.captions?.trackOf?.(app)?.id : seq.captions?.[0]?.id;
      const r = await Cut.export.framePng(app.project, seq.id, t, { width, captionTrack: track || null });
      return r.ok ? { ok: true, base64: base64(r.bytes), width: r.width, height: r.height } : { ok: false, error: r.error };
    },
    async transcript(seq) {
      const app = Cut.app;
      if (!ui.speech || seq.id !== app.sequenceId) return [];
      const clips = ui.speech.speechClips(app, { selected: false });
      if (!clips.length) return [];
      await ui.speech.loadCached?.(app).catch(() => false);
      const words = ui.speech.timelineWords(app, clips);
      return Cut.ai.segmentsFromWords(words, { frame: Cut.time.frameTicks(seq.fps) }).map((s) => ({ start: s.start / T(), end: s.end / T(), text: s.text }));
    },
    async silence(seq, opts) {
      const app = Cut.app;
      if (seq.id !== app.sequenceId) app.setSequence(seq.id);
      return ui.auto?.silencePlan ? ui.auto.silencePlan(app, { ...opts, margin: 0.1 }) : null;
    },
    seek(t) { if (ui.monitors?.program?.seek) ui.monitors.program.seek(t); else Cut.app.setTime(t); },
    play() { if (!Cut.app.playing) ui.monitors?.program?.run?.('playPause'); },
    stop() { if (Cut.app.playing) ui.monitors?.program?.pause?.(); },
    // run_action, automation, import, save, the exports, the queue, proxies (ui-control.js)
    ...ui.controlServices,
  };

  // ---------- the bridge ----------
  let turn = null; // the running chat turn: {id, request, floor (history position at its start), history, answer, stopped}
  let queue = Promise.resolve();
  let calling = null; // the call running now: {client, ctl} (Stop and Disconnect end a long one)
  const listeners = new Set(); // panels: fn(event)
  const tell = (e) => { for (const fn of listeners) { try { fn(e); } catch (err) { log.error(err?.stack || String(err)); } } };

  // An edit landed: its sequence in front, its clips flashing, the playhead on it.
  function land(edit) {
    const app = Cut.app;
    if (!edit || !app.project) return;
    if (edit.seqId && edit.seqId !== app.sequenceId && app.project.sequences.some((s) => s.id === edit.seqId)) app.setSequence(edit.seqId);
    if (edit.clips?.length) ui.timeline.flash?.(edit.clips);
    if (Number.isFinite(edit.at) && !app.playing) {
      const seq = app.sequence;
      const t = seq ? Cut.time.snap(Math.max(0, edit.at), seq.fps) : edit.at;
      services.seek(t);
    }
  }
  function content(r) {
    const text = r.ok ? JSON.stringify(r.value ?? {}) : r.error;
    const out = [{ type: 'text', text }];
    if (r.ok && r.image) out.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
    return { content: out, isError: !r.ok };
  }
  async function handle({ id, name, args, client }) {
    const app = Cut.app;
    let r;
    if (!app?.history) r = { ok: false, error: 'The editor is not ready.' };
    else if (client?.kind === 'chat' && (!turn || turn.id !== client.turn || turn.stopped)) r = { ok: false, error: 'This request has ended; nothing more can be changed in it.' };
    else if (client?.kind === 'external' && setting('cut.control.external') !== true) r = { ok: false, error: 'External AIs are not allowed in Nano Studio Cut\'s settings.' };
    else {
      const ctl = new AbortController();
      calling = { client, ctl };
      // a long job's progress shows on its step in the chat
      const progress = (fraction, text) => tell({ type: 'progress', turn: client?.kind === 'chat' ? client.turn : null, name, fraction, text: text || '' });
      const env = { app, services, undoFloor: client?.kind === 'chat' ? turn.floor : null, signal: ctl.signal, progress };
      try { r = await K.call(name, args, env); } finally { calling = null; }
      if (r.ok && r.edit && !(client?.kind === 'chat' && (turn?.id !== client.turn || turn?.stopped))) land(r.edit);
    }
    if (client?.kind === 'external') tell({ type: 'external', name, args, ok: r.ok, error: r.ok ? '' : r.error });
    return content(r);
  }
  ide.api.on('cut:controlCall', (call) => {
    queue = queue.then(() => handle(call)).catch((err) => ({ content: [{ type: 'text', text: `The editor failed: ${err?.message || err}` }], isError: true }))
      .then((result) => ide.api.send('cut:controlResult', { id: call.id, result }));
  });
  const listTools = () => invoke('cut:controlTools', K.definitions(), K.INSTRUCTIONS).catch((err) => log.warn(`the control tools were not listed: ${err?.message || err}`));
  listTools();

  // ---------- external AIs ----------
  let externalInfo = null; // {on, url, token}
  let clients = []; // connected external AIs: [{name, since}]
  const infoListeners = new Set();
  async function applyExternal() {
    externalInfo = await invoke('cut:controlExternal', setting('cut.control.external') === true).catch(() => null);
    for (const fn of infoListeners) fn(externalInfo);
  }
  ide.on('settingsChanged', (k) => { if (k === 'cut.control.external') applyExternal(); });
  if (setting('cut.control.external') === true) applyExternal();
  ide.api.on('cut:controlClients', (s) => { clients = Array.isArray(s?.external) ? s.external : []; banner(); });
  async function disconnect() {
    if (calling?.client?.kind === 'external') calling.ctl.abort();
    externalInfo = await invoke('cut:controlDisconnect').catch(() => externalInfo);
    clients = [];
    banner();
    for (const fn of infoListeners) fn(externalInfo);
    ui.toast(tr('The external AI was disconnected. It needs the new token to connect again.'));
  }
  // The banner over the editor while an external AI is connected.
  function banner() {
    const root = document.querySelector('.cut-root');
    if (!root) return;
    let b = root.querySelector(':scope > .cut-as-banner');
    const on = clients.length > 0 && setting('cut.control.external') === true;
    if (!on) { if (b) b.hidden = true; return; }
    if (!b) {
      b = el('div', 'cut-as-banner', undefined, { role: 'status' });
      b.append(el('span', 'cut-as-banner-dot'), el('span', 'cut-as-banner-text'), button({ label: tr('Disconnect'), cls: 'cut-as-disconnect', onClick: () => disconnect() }));
      root.appendChild(b);
    }
    b.querySelector('.cut-as-banner-text').textContent = tr('An external AI ({name}) is editing in Cut.', { name: clients.map((x) => x.name).join(', ') });
    b.hidden = false;
  }
  const config = (info) => ({
    command: `claude mcp add --transport http nano-cut ${info.url} --header "Authorization: Bearer ${info.token}"`,
    json: JSON.stringify({ mcpServers: { 'nano-cut': { type: 'http', url: info.url, headers: { Authorization: `Bearer ${info.token}` } } } }, null, 2),
  });

  // ---------- the chat turn ----------
  const SYSTEM = [
    'You are the editing assistant inside Nano Studio Cut, a video editor. The user watches the timeline and the program',
    'monitor change while you work, step by step.',
    'Do what the user asks with the Cut tools. Read first when you need ids or details (get_sequence, get_clip; get_frame',
    'shows you the picture), then edit. Make only the edits that were asked for. Times are seconds on the timeline.',
    'A tool result says what changed; a refused edit changed nothing, so fix the arguments or explain.',
    'When you are done, answer in one to three short sentences, in the language the user wrote in (Korean when they',
    'write Korean), saying what you changed. Never claim an edit that did not succeed.',
    'You cannot open other projects, delete files or run programs. import_media, the exports and save_project ask the',
    'user where the tools say so, and a job that needs a model asks the user to download it; when the user says no,',
    'tell them what was not done. For a keyboard or menu command without its own tool, use list_actions and run_action.',
    K.INSTRUCTIONS,
  ].join(' ');
  const conversation = []; // [{request, answer}] of this project
  let conversationOf = null;
  let turnSeq = 0;
  async function prompt(request) {
    const app = Cut.app;
    const state = await K.call('get_state', {}, { app, services });
    const seq = await K.call('get_sequence', { max_clips: 150 }, { app, services });
    const earlier = conversation.slice(-HISTORY_TURNS).map((t) => `User: ${t.request}\nAssistant: ${String(t.answer || '').slice(0, 600)}`).join('\n\n');
    return [
      earlier ? `Earlier in this conversation:\n${earlier}\n` : '',
      `The editor now (JSON):\n${JSON.stringify({ state: state.value, sequence: seq.ok ? seq.value : null })}`,
      '',
      `The user's request: ${request}`,
    ].join('\n');
  }
  function acknowledged() {
    if (setting('cut.assistant.acknowledged') === true) return Promise.resolve(true);
    return new Promise((resolve) => {
      let ok = false;
      const body = el('div', 'cut-form cut-ai-notice');
      body.append(
        el('div', 'dialog-message', tr('The AI assistant sends your request and a description of the project (clip, track and marker names and times, captions) to Claude (Anthropic) through Claude Code on this PC, and lets Claude edit the project with Cut\'s tools.')),
        el('div', 'cut-dialog-note', tr('When Claude asks to see a frame, a picture of the program monitor is sent too. Files and file paths are not sent, and Claude cannot change files on this PC.')),
      );
      ui.dialog({ title: tr('AI Assistant'), id: 'cutAsNotice', body, width: 500, onClose: () => resolve(ok),
        buttons: [{ label: tr('Continue'), primary: true, run: () => { ok = true; ide.settings.set('cut.assistant.acknowledged', true); } }, { label: tr('Cancel') }] });
    });
  }
  const labelOf = (request) => { const s = String(request).replace(/\s+/g, ' ').trim(); return [...s].length > 60 ? `${[...s].slice(0, 59).join('')}…` : s; };

  async function ask(request) {
    const app = Cut.app;
    if (turn || !app?.history || !request.trim()) return null;
    if (!(await acknowledged())) return null;
    const st = await invoke('cut:aiStatus').catch(() => null);
    if (!st?.installed) { ui.ai?.explain?.('not-installed'); tell({ type: 'missing' }); return null; }
    if (conversationOf !== app.history) { conversation.length = 0; conversationOf = app.history; }
    turn = { id: `turn${++turnSeq}`, request, floor: app.history.position, history: app.history, answer: '' };
    const my = turn;
    tell({ type: 'start', turn: my.id, request });
    let r;
    try {
      r = await invoke('cut:agentRun', { turn: my.id, system: SYSTEM, prompt: await prompt(request), model: ui.ai?.model?.() || 'sonnet' });
    } catch (err) {
      r = { ok: false, code: 'cli', error: err?.message || String(err) };
    }
    // the calls still queued belong to the turn: let them finish first
    await queue;
    if (turn === my) turn = null;
    const steps = my.history === app.history ? app.history.position - my.floor : 0;
    if (steps > 0) app.history.squash(my.floor, labelOf(request));
    conversation.push({ request, answer: r?.ok ? r.text : '' });
    tell({ type: 'end', turn: my.id, ok: !!r?.ok, code: r?.code || null, error: r?.error || '', text: r?.text || my.answer, steps });
    if (!r?.ok && (r?.code === 'not-installed' || r?.code === 'auth' || r?.code === 'quota')) ui.ai?.explain?.(r.code, r.code === 'quota' ? r.error : '');
    return r;
  }
  function stop() {
    if (!turn) return false;
    const id = turn.id;
    // nothing of this turn lands after Stop, not even a call already on its way
    turn.stopped = true;
    if (calling?.client?.kind === 'chat') calling.ctl.abort();
    invoke('cut:agentStop', id).catch(() => {});
    tell({ type: 'stopping', turn: id });
    return true;
  }
  ide.api.on('cut:agentEvent', (e) => {
    if (!e?.turn) return;
    if (e.type === 'text' && turn?.id === e.turn) turn.answer = e.text;
    tell({ ...e, type: `agent.${e.type}` });
  });

  // ---------- the panel ----------
  const EXAMPLES = ['Cut the first 3 seconds and add a title', 'Make the music 6 dB quieter', 'Add a chapter marker at every scene'];
  function mount(root, app) {
    root.classList.add('cut-assistant');
    const logBox = el('div', 'cut-as-log', undefined, { role: 'log', 'aria-live': 'polite' });
    const empty = el('div', 'cut-as-empty');
    empty.append(el('div', 'cut-as-empty-title', tr('Ask the AI to edit')), el('div', 'cut-as-empty-note', tr('Claude edits this project with Cut\'s tools while you watch. Each request is one undo step.')));
    const chips = el('div', 'cut-as-examples');
    for (const x of EXAMPLES) {
      const b = button({ label: tr(x), cls: 'cut-as-example' });
      b.addEventListener('click', () => { input.value = tr(x); input.focus(); fit(); });
      chips.appendChild(b);
    }
    empty.appendChild(chips);
    logBox.appendChild(empty);
    const form = el('div', 'cut-as-form');
    const input = el('textarea', 'cut-as-input', undefined, { rows: 2, placeholder: tr('Ask for an edit, e.g. cut the first 3 seconds and add a title'), 'aria-label': tr('Request') });
    const sendBtn = button({ label: tr('Send'), cls: 'accent cut-as-send', onClick: () => submit() });
    const stopBtn = button({ label: tr('Stop'), cls: 'cut-as-stop', onClick: () => stop() });
    stopBtn.hidden = true;
    const status = el('div', 'cut-as-status');
    form.append(input, el('div', 'cut-as-actions', undefined), status);
    form.querySelector('.cut-as-actions').append(sendBtn, stopBtn);
    root.append(logBox, form);

    const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, Math.max(44, input.scrollHeight))}px`; };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      e.stopPropagation();
    });
    function submit() {
      const text = input.value.trim();
      if (!text || turn) return;
      input.value = '';
      fit();
      ask(text);
    }
    const scroll = () => { logBox.scrollTop = logBox.scrollHeight; };
    let current = null; // {box, text, steps, byId}
    let externalBox = null;
    function bubble(kind, text) {
      empty.hidden = true;
      const b = el('div', `cut-as-msg ${kind}`);
      if (text) b.appendChild(el('div', 'cut-as-text', text));
      logBox.appendChild(b);
      scroll();
      return b;
    }
    function step(list, name, input2) {
      const [text, params] = K.describe(name, input2);
      // a keyboard action by the name its key has in the shortcut list
      if (name === 'run_action' && params.id) params.id = ui.keys?.title?.(params.id) || params.id;
      const li = el('li', 'cut-as-step', undefined, { 'data-state': 'running', 'data-tool': name });
      li.append(el('span', 'cut-as-step-mark'), el('span', 'cut-as-step-text', tr(text, params)));
      list.appendChild(li);
      scroll();
      return li;
    }
    function result(li, ok, text) {
      li.querySelector('.cut-as-step-progress')?.remove();
      li.dataset.state = ok ? 'done' : 'refused';
      if (!ok && text) li.appendChild(el('div', 'cut-as-step-error', text));
      scroll();
    }
    const working = (on) => {
      sendBtn.hidden = on;
      stopBtn.hidden = !on;
      root.classList.toggle('working', on);
    };
    const off = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
    const unlisten = off((e) => {
      switch (e.type) {
        case 'start': {
          bubble('user', e.request);
          const box = bubble('assistant');
          const text = el('div', 'cut-as-text cut-as-thinking', tr('Thinking…'));
          const steps = el('ol', 'cut-as-steps');
          box.append(steps, text);
          current = { turn: e.turn, box, text, steps, byId: new Map() };
          externalBox = null;
          working(true);
          status.textContent = tr('Claude is working on it…');
          break;
        }
        case 'agent.text':
          if (current?.turn !== e.turn) break;
          current.text.classList.remove('cut-as-thinking');
          current.text.textContent = e.text;
          if (e.final) {
            // what Claude said before its next tool calls stays above them
            current.steps.appendChild(el('li', 'cut-as-note', e.text));
            current.text.classList.add('cut-as-thinking');
            current.text.textContent = tr('Thinking…');
          }
          scroll();
          break;
        case 'agent.tool':
          if (current?.turn !== e.turn) break;
          current.byId.set(e.id, step(current.steps, e.name, e.input));
          status.textContent = tr('Step {n}…', { n: current.byId.size });
          break;
        case 'agent.result': {
          const li = current?.turn === e.turn ? current.byId.get(e.id) : null;
          if (li) result(li, e.ok, e.ok ? '' : e.text);
          break;
        }
        case 'progress': {
          // the running step of that tool in this turn
          if (current?.turn !== e.turn) break;
          const li = [...current.steps.querySelectorAll(`.cut-as-step[data-state="running"][data-tool="${e.name}"]`)].pop();
          if (!li) break;
          let p = li.querySelector('.cut-as-step-progress');
          if (!p) { p = el('div', 'cut-as-step-progress'); p.append(el('span', 'cut-as-step-bar'), el('span', 'cut-as-step-progress-text')); li.appendChild(p); }
          const f = Math.max(0, Math.min(1, Number(e.fraction) || 0));
          p.dataset.progress = f.toFixed(3);
          p.querySelector('.cut-as-step-bar').style.setProperty('--p', `${(f * 100).toFixed(1)}%`);
          p.querySelector('.cut-as-step-progress-text').textContent = e.text ? `${Math.round(f * 100)}% · ${e.text}` : `${Math.round(f * 100)}%`;
          break;
        }
        case 'stopping':
          if (current?.turn === e.turn) status.textContent = tr('Stopping…');
          break;
        case 'end': {
          if (current?.turn !== e.turn) break;
          for (const li of current.steps.querySelectorAll('.cut-as-step[data-state="running"]')) li.dataset.state = e.ok ? 'done' : 'stopped';
          const last = current.steps.lastElementChild;
          const finalText = e.ok ? String(e.text || '').trim() : '';
          if (finalText && last?.classList.contains('cut-as-note') && last.textContent === finalText) last.remove();
          current.text.classList.remove('cut-as-thinking');
          if (e.ok) current.text.textContent = finalText || tr('Done.');
          else if (e.code === 'cancelled') current.text.textContent = tr('Stopped. What was done so far is kept as one undo step.');
          else current.text.textContent = e.code === 'not-installed' ? tr('Claude Code is not installed on this PC.') : e.code === 'auth' ? tr('Claude Code is not signed in, or its sign-in has expired.')
            : e.code === 'quota' ? tr('Your Claude account has reached its usage limit for now.') : e.code === 'timeout' ? tr('Claude did not finish in time.') : tr('Claude Code failed: {error}', { error: e.error });
          current.box.dataset.result = e.ok ? 'ok' : e.code || 'error';
          if (e.steps) current.box.appendChild(el('div', 'cut-as-undo', tr('{n} edits · Ctrl+Z undoes them all', { n: e.steps })));
          current = null;
          working(false);
          status.textContent = '';
          scroll();
          break;
        }
        case 'missing':
          bubble('assistant error', tr('Claude Code is not installed on this PC.'));
          break;
        case 'external': {
          if (!externalBox || externalBox !== logBox.lastElementChild) {
            externalBox = bubble('external');
            externalBox.appendChild(el('div', 'cut-as-who', tr('External AI')));
            externalBox.appendChild(el('ol', 'cut-as-steps'));
          }
          const li = step(externalBox.querySelector('.cut-as-steps'), e.name, e.args);
          result(li, e.ok, e.error);
          break;
        }
        default:
      }
    });
    if (turn) working(true);
    return {
      dispose: () => unlisten(),
      focus: () => input.focus(),
    };
  }
  ui.registerPanel('assistant', { title: () => tr('AI Assistant'), mount });

  // ---------- the settings page's section (ui-settings.js) ----------
  function settingsSection(host, ctx) {
    const sec = ctx.ui.section(host, tr('AI Control'));
    sec.appendChild(ctx.ui.checkbox('cut.control.external', tr('Let external AIs operate Cut')));
    sec.appendChild(el('div', 'muted settings-note', tr('An AI app on this PC (Claude Code, Claude Desktop or another MCP client) can then read and edit the open project with the same tools as the AI assistant. It needs the token below; a connection without it is refused. Its edits show live and can be undone.')));
    const box = el('div', 'cut-as-connect');
    sec.appendChild(box);
    const copyRow = (label, text, cls) => {
      const row = el('div', `cut-as-connect-row ${cls}`);
      const head = el('div', 'cut-as-connect-head');
      head.append(el('span', 'cut-as-connect-label', label), button({ label: tr('Copy'), cls: 'cut-as-copy', onClick: async () => { await invoke('clipboard:writeText', text); ui.toast(tr('Copied')); } }));
      row.append(head, el('pre', 'cut-as-code', text));
      return row;
    };
    const render = (info) => {
      box.replaceChildren();
      const on = setting('cut.control.external') === true;
      // the check box is a pending change until Apply or OK
      const wanted = ctx.value('cut.control.external') === true;
      box.hidden = !on && !wanted;
      if (!on && !wanted) return;
      if (!on) { box.appendChild(el('div', 'muted settings-note cut-as-connect-pending', tr('Apply to allow it; then this shows how to connect.'))); return; }
      if (!wanted) { box.appendChild(el('div', 'muted settings-note cut-as-connect-pending', tr('Apply to stop allowing it; external AIs are then refused.'))); return; }
      if (!info?.on) { box.appendChild(el('div', 'muted settings-note', info?.error ? tr('The control server could not start.') : tr('Starting…'))); return; }
      const c = config(info);
      box.append(
        copyRow(tr('Claude Code (run in a terminal):'), c.command, 'cut-as-connect-command'),
        copyRow(tr('Other MCP clients (JSON):'), c.json, 'cut-as-connect-json'),
      );
      const again = button({ label: tr('New Token'), cls: 'cut-as-new-token', onClick: () => disconnect() });
      const row = el('div', 'cut-as-connect-foot');
      row.append(again, el('span', 'muted', tr('A new token disconnects every external AI; set them up again with the new one.')));
      box.appendChild(row);
    };
    render(externalInfo);
    infoListeners.add(render);
    sec.querySelector('input[data-key="cut.control.external"]')?.addEventListener('change', () => render(externalInfo));
    if (setting('cut.control.external') === true && !externalInfo) applyExternal();
    // the page is rebuilt when it opens again: forget this render then
    const gone = new MutationObserver(() => { if (!host.isConnected) { infoListeners.delete(render); gone.disconnect(); } });
    gone.observe(document.body, { childList: true, subtree: true });
  }

  ui.assistant = {
    ask, stop, settingsSection, disconnect, defaults: DEFAULTS,
    get running() { return turn ? { id: turn.id, request: turn.request } : null; },
    get external() { return { info: externalInfo, clients: [...clients] }; },
    relist: listTools,
  };
})();
