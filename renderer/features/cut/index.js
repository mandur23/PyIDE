// Nano Studio Cut, the video editor (docs/cut-architecture.md). This file loads the editor's scripts in order and
// starts it in #cutHost once the Cut workspace is open (cutReady). Every script adds itself to the global Cut:
// the engine's pure modules (time, model, commands, the container readers and writer...) are also require()d by the
// Node tests, and the panels register with Cut.ui. Each area keeps its own stylesheet in css/.
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const log = ide.logger('#cut');
  const SCRIPTS = [
    // shared
    'time.js', 'state.js',
    // formats: containers in and out
    'codecs.js', 'mp4read.js', 'mkvread.js', 'audioread.js', 'probe.js', 'mp4write.js',
    // the project: caption word timings, the time remapping curve, model, keyframes, masks, edit commands, captions files
    'captionwords.js', 'remap.js', 'model.js', 'keyframes.js', 'masks.js', 'commands.js', 'srt.js',
    // the engine: effects, text, media, decoding, compositing, playback, thumbnails
    'lumetri.js', 'effects.js', 'scopes.js', 'textrender.js', 'media.js', 'decoder.js', 'compositor.js', 'player.js', 'thumbs.js',
    // sound and export
    'presets.js', 'audiofx.js', 'audioengine.js', 'export.js', 'testsrc.js',
    // automation: signal analysis, what is done with speech recognition's words, Claude's prompts and answers, and the
    // tools an AI edits with (the control API)
    'analyze.js', 'speech.js', 'speakers.js', 'ai.js', 'control.js',
    // the screen
    'ui-base.js', 'ui-shell.js', 'ui-project.js', 'ui-monitors.js', 'ui-export.js', 'ui-captions.js', 'ui-keys.js',
    'ui-timeline.js', 'ui-controls.js', 'ui-effects.js', 'ui-text.js', 'ui-color.js', 'ui-scopes.js', 'ui-overlay.js', 'ui-masks.js', 'ui-auto.js',
    'ui-history.js', 'ui-meters.js', 'ui-markers.js', 'ui-mixer.js', 'ui-audiofx.js',
    // speech recognition: auto captions, the transcript panel, filler words; text AI through Claude; voice isolation;
    // the AI assistant and the control API's tools in the page
    'ui-speech.js', 'ui-speakers.js', 'ui-ai.js', 'ui-voice.js', 'ui-assistant.js',
    // convenience: the shortcut editor, the settings page, proxies, the export queue; Premiere's Tools panel and menu bar
    'ui-shortcuts.js', 'ui-settings.js', 'ui-proxy.js', 'ui-queue.js', 'ui-toolspanel.js', 'ui-menubar.js',
  ];
  const STYLES = ['shell.css', 'timeline.css', 'panels.css', 'tools.css', 'speech.css', 'speakers.css', 'ai.css', 'assistant.css', 'color.css', 'audio.css'];
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  for (const file of STYLES) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${here}css/${file}`;
    link.onerror = () => log.warn(`no stylesheet css/${file}`);
    document.head.appendChild(link);
  }
  // Scripts run in this order (async = false); Cut.loaded settles once the last one has.
  Cut.loaded = new Promise((resolve) => {
    let left = SCRIPTS.length;
    const done = () => { if (--left === 0) resolve(); };
    for (const file of SCRIPTS) {
      const script = document.createElement('script');
      script.src = `${here}${file}`;
      script.async = false;
      script.onload = done;
      script.onerror = () => { log.error(`cannot load ${file}`); done(); };
      document.body.appendChild(script);
    }
  });

  ide.on('cutReady', async ({ host }) => {
    await Cut.loaded;
    if (!Cut.ui?.start) return void log.error('the editor screen (ui-shell.js) is missing');
    const app = Cut.state.createApp();
    Cut.app = app;
    try {
      await Cut.ui.start(host, app);
      window.__cutReady = true;
    } catch (err) {
      log.error(`the editor did not start: ${err?.stack || err}`);
    }
  });
})();
