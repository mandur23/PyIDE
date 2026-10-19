// Python Packages tool window: pip list / install / upgrade / uninstall for the current interpreter. Nothing runs pip
// except list until the user clicks.
(() => {
  const { el } = ide.util;
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  // Package names and versions are user data, not UI text.
  const userText = (n) => { n.dataset.userText = ''; return n; };
  let packages = [];
  let selected = null;
  let busy = false;
  let search, listEl, details, con, interpLabel;

  const tw = ide.registerToolWindow({
    id: 'PythonPackages', title: tr('Python Packages'), icon: '📦', side: 'bottom', order: 60,
    mount(container, tw) {
      const root = el('div', 'pkgs');
      const left = el('div', 'pkgs-left');
      search = el('input', 'input pkgs-search');
      search.id = 'pkgSearch';
      search.placeholder = tr('Search or type a package name to install');
      search.oninput = renderList;
      search.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const q = search.value.trim();
        const hit = packages.find((p) => norm(p.name) === norm(q));
        if (hit) select(hit.name); else if (q) install(q);
      };
      interpLabel = el('div', 'pkgs-interp muted');
      listEl = el('div', 'list pkgs-list');
      listEl.id = 'pkgList';
      left.append(search, interpLabel, listEl);
      const right = el('div', 'pkgs-right');
      details = el('div', 'pkgs-details');
      details.id = 'pkgDetails';
      const out = el('div', 'pkgs-out');
      con = ide.ui.console(out);
      con.out.id = 'pkgOut';
      right.append(details, out);
      root.append(left, right);
      container.appendChild(root);
      tw.setActions([{ icon: '⟳', title: tr('Refresh'), run: refresh }]);
    },
  });

  let seq = 0;
  async function refresh() {
    const interp = ide.currentInterp();
    interpLabel.textContent = interp ? tr('Installed in {interpreter}', { interpreter: interp.label }) : tr('No interpreter');
    const my = ++seq;
    if (!interp) { packages = []; renderList(); return; }
    listEl.replaceChildren(el('div', 'list-row muted', tr('Loading…')));
    const r = await ide.api.invoke('packages:list', interp);
    if (my !== seq) return;
    packages = r.ok ? r.packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
    if (!r.ok) con.append(`${r.error}\n`, 'err'); // pip's own stderr
    if (selected && !packages.some((p) => norm(p.name) === norm(selected))) selected = null;
    renderList();
    renderDetails();
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    listEl.replaceChildren();
    const shown = packages.filter((p) => !q || p.name.toLowerCase().includes(q));
    for (const p of shown) {
      const row = el('div', 'list-row pkg-row' + (selected && norm(selected) === norm(p.name) ? ' selected' : ''));
      row.dataset.name = p.name;
      row.append(userText(el('span', 'pkg-name', p.name)), userText(el('span', 'pkg-ver', p.version)));
      row.onclick = () => select(p.name);
      listEl.appendChild(row);
    }
    if (q && !packages.some((p) => norm(p.name) === norm(q))) {
      const row = el('div', 'list-row pkg-install-row');
      row.id = 'pkgInstallRow';
      row.append(el('span', null, tr("Install '{name}'", { name: search.value.trim() })), el('span', 'pkg-ver', tr('from PyPI')));
      row.onclick = () => install(search.value.trim());
      listEl.appendChild(row);
    } else if (!shown.length) listEl.appendChild(el('div', 'list-row muted', tr('No packages')));
  }

  function select(name) {
    selected = name;
    renderList();
    renderDetails();
  }

  function renderDetails() {
    details.replaceChildren();
    const p = selected && packages.find((x) => norm(x.name) === norm(selected));
    if (!p) { details.appendChild(el('div', 'muted', tr('Select a package to see actions'))); return; }
    const head = el('div', 'pkg-title');
    head.append(userText(el('span', null, p.name)), userText(el('span', 'pkg-ver', p.version)));
    const btns = el('div', 'pkg-buttons');
    const upgrade = el('button', 'secondary', tr('Upgrade'));
    upgrade.id = 'pkgUpgrade';
    const remove = el('button', 'secondary', tr('Uninstall'));
    remove.id = 'pkgUninstall';
    upgrade.disabled = remove.disabled = busy;
    upgrade.onclick = () => runPip('packages:upgrade', p.name);
    remove.onclick = () => ide.ui.dialog({
      title: tr('Uninstall Package'),
      body: el('div', null, tr("Uninstall '{name}' {version} from {interpreter}?", { name: p.name, version: p.version, interpreter: ide.currentInterp()?.label })),
      width: 420,
      buttons: [{ label: tr('Uninstall'), primary: true, run: () => { runPip('packages:uninstall', p.name); } }, { label: tr('Cancel') }],
    });
    btns.append(upgrade, remove);
    details.append(head, btns);
  }

  function install(spec) {
    const name = spec.split(/[<>=!~\[; ]/)[0];
    selected = /[\\/]/.test(name) ? null : name;
    return runPip('packages:install', spec);
  }

  // Console headers per pip command, as whole sentences so a translation can order the words freely.
  const MESSAGES = {
    'packages:install': { start: 'Installing {name} into {interpreter}', done: 'Installed {name}', failed: 'Failed to install {name} (exit code {code})' },
    'packages:upgrade': { start: 'Upgrading {name} in {interpreter}', done: 'Upgraded {name}', failed: 'Failed to upgrade {name} (exit code {code})' },
    'packages:uninstall': { start: 'Uninstalling {name} from {interpreter}', done: 'Uninstalled {name}', failed: 'Failed to uninstall {name} (exit code {code})' },
  };

  async function runPip(channel, arg) {
    const interp = ide.currentInterp();
    if (!interp || busy) return;
    const msg = MESSAGES[channel];
    busy = true;
    renderDetails();
    con.clear();
    con.append(`${tr(msg.start, { name: arg, interpreter: interp.label })}\n`, 'sys');
    const id = await ide.api.invoke(channel, interp, arg);
    ide.proc.attach(id, {
      data: (text, stream) => con.append(text, stream === 'err' && !/^\s*(WARNING|DEPRECATION)/.test(text) ? 'err' : null),
      async exit(code) {
        busy = false;
        con.append(`\n${code === 0 ? tr(msg.done, { name: arg }) : tr(msg.failed, { name: arg, code })}\n`, code === 0 ? 'ok' : 'err');
        if (code === 0 && channel === 'packages:install') search.value = '';
        await refresh();
      },
    });
  }

  ide.on('interpreterChanged', () => { selected = null; if (tw.isVisible()) refresh(); else packages = []; });
  ide.on('toolWindowShown', (id) => id === 'PythonPackages' && refresh());
})();
