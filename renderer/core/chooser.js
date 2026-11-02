// The start chooser (main/windows.js): which app this process runs, Code (the IDE) or Craft (the Minecraft app), picked
// from a Dock. Picking an icon answers main, which opens the main window in that mode; Esc or the close button quits.
// Main checks for updates meanwhile (main/features/updater.js), and a new version gets an icon of its own in the Dock:
// a click downloads it, the next one installs it.
(() => {
  const product = new URLSearchParams(location.search).get('product') || 'Nano Studio';
  const $ = (id) => document.getElementById(id);
  const RING = 2 * Math.PI * 40;

  document.title = product;
  $('chooserTitle').textContent = product;
  $('chooserAsk').textContent = tr('What would you like to open?');
  $('chooserHint').textContent = tr('Choose an app from the Dock');
  const close = $('chooserClose');
  close.title = tr('Close');
  const cards = {
    code: { name: `${product} Code`, sub: tr('Python and web development') },
    craft: { name: `${product} Craft`, sub: tr('Play Minecraft and run servers') },
  };
  let picked = false;
  const hoverFocus = (button) => { button.onmouseenter = () => button.focus(); };
  for (const card of document.querySelectorAll('.chooser-card')) {
    const c = cards[card.dataset.mode];
    card.querySelector('.chooser-name').textContent = c.name;
    card.querySelector('.chooser-sub').textContent = c.sub;
    card.setAttribute('aria-label', `${c.name}, ${c.sub}`);
    hoverFocus(card);
    card.onclick = () => {
      if (picked) return;
      picked = true;
      document.body.classList.add('picked');
      card.classList.add('chosen');
      api.pick(card.dataset.mode);
    };
  }
  close.onclick = () => api.close();

  // ---------- updates ----------
  const update = $('chooseUpdate');
  hoverFocus(update);
  let state = {};
  const skipped = () => window.__initialSettings?.['updates.skippedVersion'] === state.available;
  // What the update icon says, by how this copy updates; null when there is nothing to offer.
  function offer() {
    const { phase, available: version, percent = 0, kind, version: current } = state;
    if (!version || skipped()) return null;
    if (phase === 'downloading') return tr('Downloading Nano Studio {version}… {percent}%', { version, percent });
    if (phase === 'downloaded') return tr('Restart to Update');
    if (phase === 'error') return tr('Could not download Nano Studio {version}.', { version });
    if (phase !== 'available') return null;
    if (kind === 'source') return tr('Nano Studio updates itself only when it was installed with the Nano Studio installer.');
    return tr('Nano Studio {version} is available. You have {current}.', { version, current });
  }
  function render() {
    const { phase, version, checks, error } = state;
    $('chooserVersion').textContent = version || '';
    const text = offer();
    const busy = phase === 'downloading';
    update.hidden = $('chooserSep').hidden = !text;
    $('chooserUpdateTip').textContent = text || '';
    update.title = text || '';
    update.setAttribute('aria-label', text || '');
    document.body.classList.toggle('updating', busy);
    $('chooserRing').hidden = !busy;
    $('chooserRingBar').setAttribute('stroke-dashoffset', String(RING * (1 - (state.percent || 0) / 100)));
    const status = $('chooserStatus');
    status.title = phase === 'error' ? error || '' : '';
    status.textContent = phase === 'checking' ? tr('Checking for updates…')
      : text ? ''
      : phase === 'error' ? tr('Could not check for updates.')
      : phase === 'idle' && checks ? tr('Nano Studio {version} is the latest version.', { version })
      : '';
  }
  api.onUpdate((s) => { state = s; render(); });
  state = api.updateState() || {};
  render();
  update.onclick = () => { if (!picked && !document.body.classList.contains('updating')) api.update(); };

  const clock = () => { $('chooserClock').textContent = new Date().toTimeString().slice(0, 5); };
  clock();
  setInterval(clock, 15000);

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
    // Left and Right move along the Dock, as Tab does.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const items = [...document.querySelectorAll('.chooser-dock button:not([hidden])')];
      const next = items.indexOf(document.activeElement) + (e.key === 'ArrowLeft' ? -1 : 1);
      items[Math.max(0, Math.min(items.length - 1, next))].focus();
    }
  });
  // The app used last comes first.
  $(window.__initialSettings?.['app.lastMode'] === 'craft' ? 'chooseCraft' : 'chooseCode').focus();
})();
