// Python Packages tool window: pip list / install / upgrade / uninstall for the current interpreter. Nothing runs pip
// except list until the user clicks.
(() => {
  const { el } = ide.util;
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  let packages = [];
  let selected = null;
  let busy = false;
  let search, listEl, details, con, interpLabel;

  const tw = ide.registerToolWindow({
    id: 'PythonPackages', title: 'Python Packages', icon: '📦', side: 'bottom', order: 60,
    mount(container, tw) {
      const root = el('div', 'pkgs');
      const left = el('div', 'pkgs-left');
      search = el('input', 'input pkgs-search');
      search.id = 'pkgSearch';
      search.placeholder = 'Search or type a package name to install';
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
      tw.setActions([{ icon: '⟳', title: 'Refresh', run: refresh }]);
    },
  });

  let seq = 0;
  async function refresh() {
    const interp = ide.currentInterp();
    interpLabel.textContent = interp ? `Installed in ${interp.label}` : 'No interpreter';
    const my = ++seq;
    if (!interp) { packages = []; renderList(); return; }
    listEl.replaceChildren(el('div', 'list-row muted', 'Loading…'));
    const r = await ide.api.invoke('packages:list', interp);
    if (my !== seq) return;
    packages = r.ok ? r.packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
    if (!r.ok) con.append(`${r.error}\n`, 'err');
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
      row.append(el('span', 'pkg-name', p.name), el('span', 'pkg-ver', p.version));
      row.onclick = () => select(p.name);
      listEl.appendChild(row);
    }
    if (q && !packages.some((p) => norm(p.name) === norm(q))) {
      const row = el('div', 'list-row pkg-install-row');
      row.id = 'pkgInstallRow';
      row.append(el('span', null, `Install '${search.value.trim()}'`), el('span', 'pkg-ver', 'from PyPI'));
      row.onclick = () => install(search.value.trim());
      listEl.appendChild(row);
    } else if (!shown.length) listEl.appendChild(el('div', 'list-row muted', 'No packages'));
  }

  function select(name) {
    selected = name;
    renderList();
    renderDetails();
  }

  function renderDetails() {
    details.replaceChildren();
    const p = selected && packages.find((x) => norm(x.name) === norm(selected));
    if (!p) { details.appendChild(el('div', 'muted', 'Select a package to see actions')); return; }
    const head = el('div', 'pkg-title');
    head.append(el('span', null, p.name), el('span', 'pkg-ver', p.version));
    const btns = el('div', 'pkg-buttons');
    const upgrade = el('button', 'secondary', 'Upgrade');
    upgrade.id = 'pkgUpgrade';
    const remove = el('button', 'secondary', 'Uninstall');
    remove.id = 'pkgUninstall';
    upgrade.disabled = remove.disabled = busy;
    upgrade.onclick = () => runPip('packages:upgrade', p.name, `Upgrading ${p.name}`);
    remove.onclick = () => ide.ui.dialog({
      title: 'Uninstall Package',
      body: el('div', null, `Uninstall '${p.name}' ${p.version} from ${ide.currentInterp()?.label}?`),
      width: 420,
      buttons: [{ label: 'Uninstall', primary: true, run: () => { runPip('packages:uninstall', p.name, `Uninstalling ${p.name}`); } }, { label: 'Cancel' }],
    });
    btns.append(upgrade, remove);
    details.append(head, btns);
  }

  function install(spec) {
    const name = spec.split(/[<>=!~\[; ]/)[0];
    selected = /[\\/]/.test(name) ? null : name;
    return runPip('packages:install', spec, `Installing ${spec}`);
  }

  async function runPip(channel, arg, title) {
    const interp = ide.currentInterp();
    if (!interp || busy) return;
    busy = true;
    renderDetails();
    con.clear();
    con.append(`${title} into ${interp.label}\n`, 'sys');
    const id = await ide.api.invoke(channel, interp, arg);
    ide.proc.attach(id, {
      data: (text, stream) => con.append(text, stream === 'err' && !/^\s*(WARNING|DEPRECATION)/.test(text) ? 'err' : null),
      async exit(code) {
        busy = false;
        con.append(code === 0 ? `\n${title}: done\n` : `\n${title}: failed (exit code ${code})\n`, code === 0 ? 'ok' : 'err');
        if (code === 0 && channel === 'packages:install') search.value = '';
        await refresh();
      },
    });
  }

  ide.on('interpreterChanged', () => { selected = null; if (tw.isVisible()) refresh(); else packages = []; });
  ide.on('toolWindowShown', (id) => id === 'PythonPackages' && refresh());
})();
