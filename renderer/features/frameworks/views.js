// The Django Structure tool window (apps, models and fields, admin registrations, URLs, settings), the Endpoints tool
// window (every route of every framework: method, path, endpoint, source), and gutter icons on view functions that
// open their route in the browser pane or the external browser.
(() => {
  const { el, basename } = ide.util;
  const fw = ide.frameworks;
  const userText = (node) => ((node.dataset.userText = ''), node);
  const rel = (p) => (p ? ide.util.rel(p) : '');
  const source = (path, line) => `${basename(path)}:${line}`;
  const jump = (path, line) => path && ide.openFile(path, { line, col: 1 });
  const methodsOf = (r) => (r.methods.length ? r.methods.join(', ') : '*');

  function routeMenu(r) {
    const canOpen = !r.methods.length || r.methods.includes('GET');
    return [
      ...(r.viewFile ? [{ label: tr('Go to View'), run: () => jump(r.viewFile, r.viewLine) }] : []),
      { label: tr('Go to Route Declaration'), run: () => jump(r.file, r.line) },
      { separator: true },
      { label: tr('Open in Browser Pane'), disabled: !canOpen, run: () => fw.openRoute(r) },
      { label: tr('Open in External Browser'), disabled: !canOpen, run: () => fw.openRoute(r, { external: true }) },
      { label: tr('Copy URL'), run: () => navigator.clipboard.writeText(fw.routeUrl(r)) },
      ...(fw.routeActions.length ? [{ separator: true }, ...fw.routeActions.map((a) => ({ label: a.title(), run: () => a.run(r) }))] : []),
    ];
  }

  // ---------- Django Structure ----------
  let djangoBody;
  const collapsed = new Set(); // node keys the user folded
  const djangoTw = ide.registerToolWindow({
    id: 'DjangoStructure', title: tr('Django Structure'), icon: '🌐', iconName: 'djangoStructure', side: 'left', order: 45,
    mount(container) {
      container.classList.add('fwk-tool');
      djangoBody = el('div', 'fw-tree');
      djangoBody.id = 'djangoStructure';
      container.appendChild(djangoBody);
    },
  });
  djangoTw.setActions([
    { icon: '⟳', title: tr('Refresh'), run: () => fw.refresh() },
    { icon: '⚙', title: tr('Run manage.py Task…'), run: () => fw.manageTaskPopup() },
    { icon: '▶', title: tr('Run Development Server'), run: () => fw.runServer('django') },
    { icon: '🐞', title: tr('Debug Development Server'), run: () => fw.runServer('django', { debug: true }) },
  ]);

  function node(parent, { key, label, detail, icon, open, depth, kind }) {
    const row = el('div', `fw-node${kind ? ` fw-${kind}` : ''}`);
    row.style.paddingLeft = `${6 + depth * 14}px`;
    const hasChildren = typeof key === 'string';
    const arrow = el('span', 'fw-arrow', hasChildren ? (collapsed.has(key) ? '▸' : '▾') : '');
    row.append(arrow, el('span', 'fw-icon', icon || ''));
    const name = el('span', 'fwk-name');
    if (label instanceof Node) name.appendChild(label); else name.textContent = label;
    row.appendChild(name);
    if (detail) row.appendChild(userText(el('span', 'fw-detail muted', detail)));
    const kids = el('div', 'fw-children');
    if (hasChildren && collapsed.has(key)) kids.classList.add('hidden');
    row.onclick = (e) => {
      if (hasChildren && (e.target === arrow || !open)) {
        const fold = !kids.classList.toggle('hidden');
        if (fold) collapsed.delete(key); else collapsed.add(key);
        arrow.textContent = kids.classList.contains('hidden') ? '▸' : '▾';
        return;
      }
      open?.();
    };
    parent.append(row, kids);
    return kids;
  }
  const userLabel = (text) => userText(el('span', null, text));

  function renderDjango(info) {
    if (!djangoBody) return;
    djangoBody.replaceChildren();
    const dj = info?.django;
    if (!dj) {
      djangoBody.appendChild(el('div', 'fw-empty muted', info ? tr('This project does not use Django.') : tr('Inspecting the project…')));
      return;
    }
    const apps = node(djangoBody, { key: 'apps', label: tr('Apps'), icon: '📦', depth: 0, kind: 'section' });
    for (const app of dj.apps) {
      const a = node(apps, { key: `app:${app.name}`, label: userLabel(app.name), icon: '📦', depth: 1, open: () => jump(app.file, 1), kind: 'app' });
      if (app.models.length) {
        const ms = node(a, { key: `models:${app.name}`, label: tr('Models'), icon: '◧', depth: 2 });
        for (const m of app.models) {
          const f = node(ms, { key: `model:${app.name}.${m.name}`, label: userLabel(m.name), detail: m.abstract ? tr('abstract') : '', icon: '◧', depth: 3, open: () => jump(m.file, m.line), kind: 'model' });
          for (const field of m.fields) node(f, { label: userLabel(field.name), detail: field.type, icon: '·', depth: 4, open: () => jump(m.file, field.line), kind: 'field' });
        }
      }
      if (app.admin.length) {
        const ad = node(a, { key: `admin:${app.name}`, label: tr('Admin'), icon: '🛡', depth: 2 });
        for (const r of app.admin) node(ad, { label: userLabel(r.model), detail: r.admin || '', icon: '·', depth: 3, open: () => jump(r.file, r.line), kind: 'admin' });
      }
    }
    const urls = node(djangoBody, { key: 'urls', label: tr('URLs'), icon: '🔗', depth: 0, kind: 'section' });
    for (const r of info.routes.filter((x) => x.framework === 'django')) {
      const row = node(urls, { label: userLabel(r.path), detail: [r.name, r.view].filter(Boolean).join('  '), icon: '·', depth: 1, open: () => jump(r.viewFile || r.file, r.viewFile ? r.viewLine : r.line), kind: 'url' });
      row.previousSibling.oncontextmenu = (e) => { e.preventDefault(); ide.ui.contextMenu(e.clientX, e.clientY, routeMenu(r)); };
    }
    if (dj.settingsFile) {
      node(djangoBody, { label: tr('Settings'), detail: dj.settingsModule, icon: '⚙', depth: 0, open: () => jump(dj.settingsFile, 1), kind: 'section' });
    }
  }

  // ---------- Endpoints ----------
  let endpointsList;
  let filterInput;
  const endpointsTw = ide.registerToolWindow({
    id: 'Endpoints', title: tr('Endpoints'), icon: '⇄', iconName: 'endpoints', side: 'bottom', order: 58,
    mount(container) {
      container.classList.add('fwk-tool', 'fw-endpoints');
      const bar = el('div', 'fw-endpoints-bar');
      filterInput = el('input', 'fw-filter');
      filterInput.placeholder = tr('Filter by path, method or endpoint');
      filterInput.oninput = () => renderEndpoints(fw.info());
      bar.appendChild(filterInput);
      const head = el('div', 'fwk-row fwk-head');
      for (const h of [tr('Method'), tr('Path'), tr('Endpoint'), tr('Source')]) head.appendChild(el('span', null, h));
      endpointsList = el('div', 'fw-endpoint-rows');
      endpointsList.id = 'endpointsList';
      container.append(bar, head, endpointsList);
    },
  });
  endpointsTw.setActions([{ icon: '⟳', title: tr('Refresh'), run: () => fw.refresh() }]);

  function renderEndpoints(info) {
    if (!endpointsList) return;
    endpointsList.replaceChildren();
    const q = (filterInput?.value || '').trim().toLowerCase();
    const routes = (info?.routes || []).filter((r) => !q || [r.path, methodsOf(r), r.name || '', r.view].some((s) => s.toLowerCase().includes(q)));
    endpointsTw.setBadge(info?.routes?.length ? String(info.routes.length) : '');
    if (!routes.length) {
      endpointsList.appendChild(el('div', 'fw-empty muted', info?.routes?.length ? tr('No endpoints match the filter.') : tr('No Django, Flask or FastAPI endpoints were found in this project.')));
      return;
    }
    for (const kind of fw.kinds()) {
      const group = routes.filter((r) => r.framework === kind);
      if (!group.length) continue;
      if (fw.kinds().length > 1) endpointsList.appendChild(userText(el('div', 'fw-group', fw.names[kind])));
      for (const r of group) {
        const row = userText(el('div', 'fwk-row fw-endpoint'));
        row.dataset.path = r.path;
        row.append(
          userText(el('span', `fw-method m-${(r.methods[0] || 'any').toLowerCase()}`, methodsOf(r))),
          userText(el('span', 'fw-path', r.path)),
          userText(el('span', 'fw-endpoint-name', r.name || r.view)),
          userText(el('span', 'fw-source muted', r.viewFile ? source(r.viewFile, r.viewLine) : source(r.file, r.line))),
        );
        row.title = rel(r.viewFile || r.file);
        row.onclick = () => {
          endpointsList.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
          row.classList.add('selected');
          jump(r.viewFile || r.file, r.viewFile ? r.viewLine : r.line);
        };
        row.oncontextmenu = (e) => { e.preventDefault(); row.onclick(); ide.ui.contextMenu(e.clientX, e.clientY, routeMenu(r)); };
        endpointsList.appendChild(row);
      }
    }
  }

  // ---------- gutter icons on views ----------
  // Lines come from the last inspection; a view is found again by name so icons follow edits made since then.
  function viewLines(model, path) {
    const routes = (fw.info()?.routes || []).filter((r) => r.viewFile && ide.util.samePath(r.viewFile, path));
    if (!routes.length) return new Map();
    const lines = model.getLinesContent();
    const byLine = new Map();
    for (const r of routes) {
      const name = r.view.split('.').pop();
      const re = new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${name}\\b`);
      let best = null;
      lines.forEach((text, i) => { if (re.test(text) && (best === null || Math.abs(i + 1 - r.viewLine) < Math.abs(best - r.viewLine))) best = i + 1; });
      if (best === null) continue;
      if (!byLine.has(best)) byLine.set(best, []);
      byLine.get(best).push(r);
    }
    return byLine;
  }

  const gutters = new Map(); // editor -> {deco, items: Map(line -> routes), timer}
  const pathOf = (model) => (model ? ide.tabs.find((t) => t.model === model)?.path || null : null);
  function refreshGutter(ed) {
    const g = gutters.get(ed);
    const model = ed.getModel();
    const path = pathOf(model);
    g.items = path && /\.py$/i.test(path) ? viewLines(model, path) : new Map();
    g.deco.set([...g.items].map(([line, routes]) => ({
      range: new ide.monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'fw-route-gutter',
        glyphMarginHoverMessage: { value: routes.map((r) => `${methodsOf(r)} \`${r.path}\``).join('  \n') + `\n\n${tr('Click to open the route in a browser')}` },
        glyphMargin: { position: ide.monaco.editor.GlyphMarginLane.Left },
      },
    })));
  }
  const refreshAll = () => { for (const ed of gutters.keys()) refreshGutter(ed); };

  function gutterMenu(routes, x, y) {
    if (routes.length === 1) return ide.ui.contextMenu(x, y, [{ label: routes[0].path, userText: true, disabled: true }, ...routeMenu(routes[0])]);
    ide.ui.contextMenu(x, y, routes.map((r) => ({ label: `${methodsOf(r)}  ${r.path}`, submenu: () => routeMenu(r) })));
  }

  const iconAt = (e) => e.button === 0 && e.target.closest?.('.fw-route-gutter');
  ide.onEditor((ed) => {
    const g = { deco: ed.createDecorationsCollection(), items: new Map(), timer: null };
    gutters.set(ed, g);
    const dom = ed.getContainerDomNode();
    for (const type of ['pointerdown', 'mousedown']) {
      dom.addEventListener(type, (e) => {
        if (!iconAt(e)) return;
        e.stopPropagation();
        if (type !== 'mousedown') return;
        e.preventDefault();
        const pos = ed.getTargetAtClientPoint(e.clientX, e.clientY)?.position;
        const routes = pos && g.items.get(pos.lineNumber);
        if (routes) gutterMenu(routes, e.clientX, e.clientY);
      }, true);
    }
    for (const type of ['pointerup', 'mouseup', 'click']) dom.addEventListener(type, (e) => iconAt(e) && e.stopPropagation(), true);
    ed.onDidChangeModel(() => refreshGutter(ed));
    ed.onDidChangeModelContent(() => { clearTimeout(g.timer); g.timer = setTimeout(() => refreshGutter(ed), 300); });
    ed.onDidDispose(() => { clearTimeout(g.timer); gutters.delete(ed); });
    refreshGutter(ed);
  });
  ide.on('activeTabChanged', refreshAll);

  fw.onChange((info) => { renderDjango(info); renderEndpoints(info); refreshAll(); });
  renderDjango(fw.info());
  renderEndpoints(fw.info());
  fw.views = { gutterLines: (ed) => [...(gutters.get(ed)?.items.keys() || [])], showEndpoints: () => endpointsTw.show(), showDjango: () => djangoTw.show() };
})();
