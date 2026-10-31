// The start chooser (main/windows.js): which app this process runs, Code (the IDE) or Craft (the Minecraft app).
// Picking a card answers main, which opens the main window in that mode; Esc or the close button quits.
(() => {
  const product = new URLSearchParams(location.search).get('product') || 'Nano Studio';
  const $ = (id) => document.getElementById(id);
  const theme = window.__initialSettings?.['appearance.theme'];
  const light = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';

  document.title = product;
  $('chooserTitle').textContent = product;
  const close = $('chooserClose');
  close.title = tr('Close');
  close.innerHTML = window.PYIDE_ICONS.closeSmall || '×';
  const cards = {
    code: { name: `${product} Code`, sub: tr('Python and web development') },
    craft: { name: `${product} Craft`, sub: tr('Play Minecraft and run servers') },
  };
  let picked = false;
  for (const card of document.querySelectorAll('.chooser-card')) {
    const c = cards[card.dataset.mode];
    card.querySelector('.chooser-name').textContent = c.name;
    card.querySelector('.chooser-sub').textContent = c.sub;
    card.querySelector('.chooser-icon').innerHTML = window.PYIDE_ICONS[card.querySelector('.chooser-icon').dataset.icon] || '';
    card.onclick = () => {
      if (picked) return;
      picked = true;
      document.body.classList.add('picked');
      card.classList.add('chosen');
      api.pick(card.dataset.mode);
    };
  }
  close.onclick = () => api.close();
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
    // Left and Right move between the cards, as Tab does.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') $(e.key === 'ArrowLeft' ? 'chooseCode' : 'chooseCraft').focus();
  });
  $('chooseCode').focus();
})();
