// The Video Editor page of the settings window (video-editor-features.md sections 16 and 17) and the top bar's
// settings menu. The settings window shows the pages marked `cut: true` in Cut (renderer/features/settings).
//
// Settings: cut.autosave.minutes and cut.autosave.keep (the interval copies, ui-shell.js), cut.cacheLimitGB (main's
// cache, with the current size and Clear Cache), cut.transitionSeconds and cut.stillSeconds (the default durations:
// new projects take them and the open project is set to them as one undo step), cut.quality (both monitors'
// playback quality), cut.proxy (the monitors' proxy switch), cut.proxy.offer (the offer on import) and
// cut.proxy.height (the proxy size, ui-proxy.js), cut.speech.model, cut.speech.language, cut.speech.lineChars and
// cut.speech.markUncertain and cut.speech.isolateVoice (speech recognition, whose section ui-speech.js adds; the
// voice isolation section is ui-voice.js'), cut.ai.model and
// cut.ai.acknowledged (text AI through Claude, whose section ui-ai.js adds).
//
// Cut.ui.settingsButton() -> the top bar's button; Cut.ui.projectDefaults() -> the project settings a new project gets.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;
  const log = ide.logger('#cut');

  const DEFAULTS = {
    'cut.autosave.minutes': 5,
    'cut.autosave.keep': 20,
    'cut.cacheLimitGB': 10,
    'cut.transitionSeconds': 1,
    'cut.stillSeconds': 5,
    'cut.quality': 1,
    'cut.proxy': false,
    'cut.proxy.offer': true,
    'cut.proxy.height': 720,
    // speech recognition (ui-speech.js)
    'cut.speech.model': 'whisper-large-v3-turbo',
    'cut.speech.language': 'auto',
    'cut.speech.lineChars': 0,
    'cut.speech.markUncertain': true,
    // the voice isolated (ui-voice.js) before speech recognition
    'cut.speech.isolateVoice': false,
    // text AI through Claude (ui-ai.js)
    'cut.ai.model': 'sonnet',
    'cut.ai.acknowledged': false,
  };
  const get = (k) => { const v = ide.settings.get(k, DEFAULTS[k]); return v === undefined || v === null ? DEFAULTS[k] : v; };
  const seconds = (k, lo, hi) => { const v = Number(get(k)); return Number.isFinite(v) && v >= lo && v <= hi ? v : DEFAULTS[k]; };

  // Durations as project settings: whole ticks, at least one.
  const ticks = (s) => Math.max(1, Math.round(s * Cut.time.TICKS));
  function projectDefaults() {
    return { transitionDuration: ticks(seconds('cut.transitionSeconds', 0.04, 60)), stillDuration: ticks(seconds('cut.stillSeconds', 0.04, 3600)) };
  }

  // The open project follows a changed default duration (one undo step), so the next transition or still uses it.
  function applyDurations() {
    const app = Cut.app;
    if (!app?.history || app.history.grouping) return;
    const want = projectDefaults();
    const s = app.project.settings;
    const patch = {};
    for (const k of Object.keys(want)) if (s[k] !== want[k]) patch[k] = want[k];
    if (Object.keys(patch).length) ui.exec(app, Cut.commands.setSettings(patch));
  }
  ide.on('settingsChanged', (k) => {
    if (k === 'cut.transitionSeconds' || k === 'cut.stillSeconds') applyDurations();
    if (k === 'cut.quality') {
      const q = [1, 0.5, 0.25].includes(Number(get('cut.quality'))) ? Number(get('cut.quality')) : 1;
      for (const kind of ['program', 'source']) ide.settings.set(`cut.${kind}.quality`, q);
    }
  });

  // ---------- the page ----------
  function mount(host, ctx) {
    const { section, fieldRow, checkbox, numberInput } = ctx.ui;
    host.classList.add('cut-settings-page');
    const pick = (key, options) => {
      const s = el('select', 'cut-settings-select');
      s.dataset.key = key;
      for (const [v, label] of options) s.add(new Option(label, String(v)));
      s.value = String(ctx.value(key) ?? DEFAULTS[key]);
      s.onchange = () => ctx.set(key, Number(s.value));
      return s;
    };

    const save = section(host, tr('Autosave'));
    save.appendChild(fieldRow(tr('Keep a copy every:'), numberInput('cut.autosave.minutes', { min: 1, max: 120 }), tr('minutes (1 – 120)')));
    save.appendChild(fieldRow(tr('Copies to keep:'), numberInput('cut.autosave.keep', { min: 1, max: 100 }), '1 – 100'));
    save.appendChild(el('div', 'muted settings-note', tr('The latest changes are also saved for recovery 2 seconds after you stop editing.')));

    const cache = section(host, tr('Media Cache'));
    cache.appendChild(fieldRow(tr('Cache limit:'), numberInput('cut.cacheLimitGB', { min: 1, max: 2000 }), tr('GB; the least recently used files go first')));
    const sizeRow = el('div', 'settings-check cut-cache-row');
    const size = el('span', 'cut-cache-size', tr('Measuring…'));
    const clear = el('button', 'secondary cut-cache-clear', tr('Clear Cache'));
    clear.type = 'button';
    sizeRow.append(el('span', null, tr('In use:')), size, clear);
    cache.appendChild(sizeRow);
    cache.appendChild(el('div', 'muted settings-note', tr('Thumbnails, waveforms and proxies. A cleared proxy is made again on request; until then the original plays.')));
    const showSize = async () => {
      const info = await ide.api.invoke('cut:cacheInfo').catch(() => null);
      size.textContent = info && !info.error ? tr('{size} in {n} files', { size: ui.formatBytes(info.bytes), n: info.files }) : tr('unknown');
      size.dataset.bytes = String(info?.bytes ?? '');
    };
    clear.onclick = async () => {
      const yes = await ui.confirm(tr('Delete the thumbnails, waveforms and proxies in the cache? They are made again when needed.'), { title: tr('Clear Cache'), ok: tr('Clear Cache') });
      if (!yes) return;
      clear.disabled = true;
      const r = await ide.api.invoke('cut:cacheClear').catch((err) => ({ error: err.message }));
      clear.disabled = false;
      if (r?.error) ui.notify(tr('The cache could not be cleared: {error}', { error: r.error.message || r.error }), { kind: 'error' });
      Cut.media?.forget?.();
      Cut.app?.emit('proxies', {});
      await showSize();
    };
    showSize();

    const timeline = section(host, tr('Timeline'));
    timeline.appendChild(fieldRow(tr('Default transition length:'), numberInput('cut.transitionSeconds', { step: 0.1, min: 0.1, max: 60 }), tr('seconds')));
    timeline.appendChild(fieldRow(tr('Default still image length:'), numberInput('cut.stillSeconds', { step: 0.5, min: 0.1, max: 3600 }), tr('seconds')));
    timeline.appendChild(el('div', 'muted settings-note', tr('New projects take these, and the open project changes to them.')));

    const play = section(host, tr('Playback'));
    play.appendChild(fieldRow(tr('Playback quality:'), pick('cut.quality', [[1, tr('Full')], [0.5, tr('1/2')], [0.25, tr('1/4')]]), tr('while playing; a paused frame is always full quality')));

    const proxy = section(host, tr('Proxies'));
    proxy.appendChild(checkbox('cut.proxy', tr('Play proxies in the monitors')));
    proxy.appendChild(checkbox('cut.proxy.offer', tr('Offer proxies when importing 4K, HEVC or long-GOP video')));
    proxy.appendChild(fieldRow(tr('Proxy size:'), pick('cut.proxy.height', [[540, '540p'], [720, '720p'], [1080, '1080p']]), tr('H.264, a keyframe every 15 frames')));
    proxy.appendChild(el('div', 'muted settings-note', tr('Export always reads the original media.')));

    ui.speech?.settingsSection(host, ctx);
    ui.voice?.settingsSection(host, ctx);
    ui.ai?.settingsSection(host, ctx);
    ui.assistant?.settingsSection(host, ctx);
  }

  (ide.settingsPages ||= []).push({
    id: 'cut', title: () => tr('Video Editor'), cut: true, index: false, defaults: DEFAULTS, mount,
    keywords: 'video editor cut autosave copies cache clear proxy transition still image duration playback quality speech recognition whisper captions transcript claude ai translate youtube shorts voice isolation demucs noise music 영상 편집 자동 저장 사본 캐시 지우기 프록시 전환 정지 이미지 길이 재생 화질 음성 인식 자막 받아쓰기 클로드 번역 유튜브 쇼츠 음성 분리 잡음 음악',
  });

  // ---------- the top bar's menu ----------
  const keyHint = (id) => ide.keymap.hint(`Cut.${id}`);
  function settingsButton() {
    const b = button({ icon: 'settings', title: tr('Settings'), cls: 'cut-settings-btn', onClick: () => {
      const m = ui.menu(b, [
        { label: tr('Video Editor Settings…'), hint: keyHint('settings'), run: () => openPage() },
        { label: tr('Keyboard Shortcuts…'), hint: keyHint('keyboardShortcuts'), run: () => ui.shortcuts?.open() },
        { label: tr('Keyboard Shortcut Overview'), hint: keyHint('keyHelp'), run: () => ui.shortcuts?.sheet() },
      ]);
      if (m) m.id = 'cutSettingsMenu';
    } });
    b.setAttribute('aria-haspopup', 'menu');
    return b;
  }
  function openPage() {
    if (typeof ide.openSettings !== 'function') return void log.warn('the settings window is not loaded');
    ide.openSettings('cut');
  }
  ui.onAction('settings', () => { openPage(); });

  Object.assign(ui, { settingsButton, projectDefaults, settingDefaults: DEFAULTS });
})();
