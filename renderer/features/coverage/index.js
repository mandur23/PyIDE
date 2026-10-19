// Run with Coverage: an executor that runs any run configuration (Python scripts, pytest, unittest) under coverage.py,
// the Coverage tool window with line and branch percentages per folder and file, and editor stripes for covered (green),
// missed (red) and partly covered (yellow) lines. A new coverage run replaces the shown data.
(() => {
  const { el, basename, joinPath, isUnder } = ide.util;
  const run = ide.run;
  if (!run?.registerExecutor) return;

  // PyCharm New UI icons (IntelliJ Platform, Apache License 2.0), with Gray7 as currentColor like renderer/core/icons.js.
  Object.assign(window.PYIDE_ICONS ||= {}, {
    runWithCoverage: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"> <g clip-path="url(#clip0_2414_33992)"> <path fill-rule="evenodd" clip-rule="evenodd" d="M9 9.50215C9 8.32441 10.2951 7.60608 11.2942 8.22967L15.2962 10.7275C16.2372 11.3149 16.2372 12.6851 15.2962 13.2725L11.2942 15.7703C10.2951 16.3939 9 15.6756 9 14.4978V9.50215ZM10.7647 9.07799C10.4317 8.87013 10 9.10957 10 9.50215V14.4978C10 14.8904 10.4317 15.1298 10.7647 14.922L14.7667 12.4241C15.0804 12.2284 15.0804 11.7716 14.7667 11.5758L10.7647 9.07799Z" fill="#208A3C"/> <path d="M10 9.50214C10 9.10956 10.4317 8.87012 10.7647 9.07798L14.7667 11.5758C15.0804 11.7716 15.0804 12.2284 14.7667 12.4241L10.7647 14.922C10.4317 15.1298 10 14.8904 10 14.4978V9.50214Z" fill="#F2FCF3"/> <path d="M14 3.00249L8 0.457031L2 3.00249V8.77794C2 10.5438 2.89245 11.8352 4.03238 12.8568C4.87083 13.6082 5.8918 14.2526 6.82862 14.8439C7.1398 15.0402 7.44176 15.2308 7.7246 15.4175L8 15.5992L8 14.4032C7.76892 14.2539 7.53551 14.1065 7.30253 13.9594C6.38473 13.3799 5.46989 12.8023 4.69977 12.1121C3.67898 11.1973 3 10.1554 3 8.77794V3.66451L8 1.5433L13 3.66451V8.11737L14 8.74152V3.00249Z" fill="currentColor"/> </g> <defs> <clipPath id="clip0_2414_33992"> <rect width="16" height="16" fill="white"/> </clipPath> </defs> </svg>',
    coverage: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M2.5 3.83333L8 1.54167L13.5 3.83333L13.5 9.17871C13.5 10.7502 12.7145 11.9168 11.6339 12.8852C10.8323 13.6036 9.84849 14.226 8.90452 14.8218L8.9021 14.8233C8.59264 15.0186 8.28712 15.2115 8 15.4009C7.71296 15.2115 7.40754 15.0187 7.09817 14.8235L7.09548 14.8218C6.15151 14.226 5.16769 13.6036 4.36607 12.8852C3.28548 11.9168 2.5 10.7502 2.5 9.17871V3.83333Z" stroke="currentColor"/> <path d="M5.5 8.5L7 10L10.5 6.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/> </svg>',
  });

  const SHOW_KEY = 'coverage.showInEditor';
  const key = (p) => p.toLowerCase();
  let suite = null; // {name, cfg, time, files: Map(key -> file), root: node, nodes: Map(key -> node)}
  let shown = ide.settings.get(SHOW_KEY, true);

  // coverage.py's display rule: never round a partial result to 0% or 100%.
  function percent(covered, total) {
    if (!total) return null;
    const pc = (100 * covered) / total;
    if (pc > 0 && pc < 1) return 1;
    if (pc > 99 && pc < 100) return 99;
    return Math.round(pc);
  }

  // ---------- coverage.py in the interpreter ----------
  let pipItem = null;
  function installItem() {
    if (pipItem || !ide.installer?.pip) return pipItem;
    // register() emits installablesChanged, which calls back here; the item is assigned before that.
    pipItem = ide.installer.pip({ package: 'coverage', name: 'coverage.py', description: tr('Measures which lines and branches of Python code run. Run with Coverage uses it.') });
    ide.installer.register(pipItem);
    return pipItem;
  }
  ide.on('installablesChanged', () => installItem());
  installItem();

  // Offers to install coverage.py with the Install Manager's pip job; resolves true once it is installed.
  function offerInstall(interp) {
    const item = installItem();
    const name = interp.label || interp.cmd;
    const project = ide.util.samePath(interp.executable || '', ide.currentInterp()?.executable || '');
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const body = el('div', 'cov-install');
      body.appendChild(el('p', null, tr('coverage.py is not installed for {interp}. Run with Coverage needs it.', { interp: name })));
      if (!item || !project) {
        const cmd = el('code', null, `${[interp.cmd, ...interp.args].join(' ')} -m pip install coverage`);
        cmd.dataset.userText = '';
        body.append(el('p', null, tr('Install it in that interpreter, then run again:')), cmd);
        ide.ui.dialog({ title: tr('Run with Coverage'), body, onClose: () => settle(false) });
        return;
      }
      body.appendChild(el('p', 'muted', tr('PyIDE will install it with pip into the project interpreter.')));
      const log = el('pre', 'cov-install-log hidden');
      log.dataset.userText = '';
      body.appendChild(log);
      ide.ui.dialog({
        title: tr('Run with Coverage'), body, width: 560, onClose: () => settle(false),
        buttons: [
          { label: tr('Cancel') },
          { label: tr('Install coverage.py'), primary: true, async run(dlg) {
            const buttons = [...dlg.el.querySelectorAll('.dialog-buttons button')];
            buttons.forEach((b) => (b.disabled = true));
            log.classList.remove('hidden');
            const write = (t) => { log.textContent = (log.textContent + t).slice(-6000); log.scrollTop = log.scrollHeight; };
            const logger = (t) => write(String(t).endsWith('\n') ? String(t) : `${t}\n`);
            logger.raw = write;
            try {
              await item.install(logger, () => {}, new AbortController().signal);
            } catch (err) {
              write(`\n${tr('Could not install coverage.py: {error}', { error: err.message })}\n`);
              buttons.forEach((b) => (b.disabled = false));
              return false;
            }
            ide.installer.refresh?.();
            settle(true);
            return true;
          } },
        ],
      });
    });
  }

  // ---------- the executor ----------
  async function prepare(cfg, interp, s) {
    // Remote interpreters (interp.target) run elsewhere, where the wrapper script is not.
    if (interp.target) {
      s.console().append(`${tr('Run with Coverage works with local interpreters only.')}\n`, 'err');
      return null;
    }
    if (!(await ide.api.invoke('coverage:version', interp)) && !(await offerInstall(interp))) {
      s.console().append(`${tr('coverage.py is not installed, so the configuration was not run with coverage.')}\n`, 'err');
      return null;
    }
    const job = await ide.api.invoke('coverage:prepare');
    s.exitHooks.push(() => collect(job, cfg, s));
    return { ...interp, args: [...interp.args, '-u', job.boot, job.data, job.summary, ide.root || '', '--'] };
  }

  async function collect(job, cfg, s) {
    const data = await ide.api.invoke('coverage:result', job.dir);
    if (!data) {
      s.con?.append(`${tr('No coverage data was collected: the process ended before coverage.py could save it.')}\n`, 'err');
      return;
    }
    setSuite({ name: cfg.name, cfg, time: new Date(), files: data.files });
    tw.show();
  }

  run.registerExecutor({
    id: 'Coverage', title: tr('Run with Coverage'), iconName: 'runWithCoverage', glyph: '⛨',
    label: (name) => tr("Run '{name}' with Coverage", { name }),
    prepare,
  });

  // ---------- the suite: per-file data and the folder tree ----------
  const zero = () => ({ statements: 0, covered: 0, branches: 0, coveredBranches: 0 });
  function addStats(to, f) {
    to.statements += f.statements;
    to.covered += f.covered;
    to.branches += f.branches;
    to.coveredBranches += f.coveredBranches;
  }

  function setSuite({ name, cfg, time, files: raw }) {
    const files = new Map();
    for (const [path, f] of Object.entries(raw)) {
      files.set(key(path), {
        path, statements: f.statements, covered: f.covered, branches: f.branches, coveredBranches: f.coveredBranches,
        executed: new Set(f.executed), missing: new Set(f.missing),
        partial: new Map(Object.entries(f.partial).map(([line, arcs]) => [Number(line), arcs])),
      });
    }
    // Folders under the project root, files outside it (rare: the source is the project) under their full path.
    const rootPath = ide.root || '';
    const root = { name: basename(rootPath) || rootPath, path: rootPath, dir: true, children: new Map(), stats: zero() };
    const nodes = new Map([[key(rootPath), root]]);
    for (const f of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = rootPath && isUnder(f.path, rootPath) ? f.path.slice(rootPath.length).split(/[\\/]/).filter(Boolean) : [f.path];
      let node = root;
      addStats(root.stats, f);
      for (const part of parts.slice(0, -1)) {
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, path: joinPath(node.path, part), dir: true, children: new Map(), stats: zero(), parent: node };
          node.children.set(part, child);
          nodes.set(key(child.path), child);
        }
        addStats(child.stats, f);
        node = child;
      }
      const leaf = { name: parts.length > 1 ? parts[parts.length - 1] : basename(f.path), path: f.path, dir: false, file: f, stats: f, parent: node };
      node.children.set(leaf.name, leaf);
      nodes.set(key(f.path), leaf);
    }
    suite = { name, cfg, time, files, root, nodes };
    selected = root;
    decorateAll();
    render();
    ide.refreshTree?.();
  }

  // ---------- editor stripes ----------
  const decorations = new WeakMap(); // model -> decoration ids
  const CLASS = { hit: 'cov-hit', miss: 'cov-miss', partial: 'cov-partial' };
  const RULER = { hit: '#5fb86599', miss: '#db5c5c99', partial: '#f2c55c99' };

  function lineState(f, line) {
    if (f.missing.has(line)) return 'miss';
    if (f.partial.has(line)) return 'partial';
    return f.executed.has(line) ? 'hit' : null;
  }

  function decorate(model, path) {
    if (!model || model.isDisposed() || !path) return;
    const f = shown && suite ? suite.files.get(key(path)) : null;
    const list = [];
    if (f) {
      const count = model.getLineCount();
      const { Range, editor } = ide.monaco;
      for (const line of [...f.executed, ...f.missing]) {
        const state = lineState(f, line);
        if (line > count || !state) continue;
        list.push({
          range: new Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `cov-line ${CLASS[state]}`,
            overviewRuler: { color: RULER[state], position: editor.OverviewRulerLane.Left },
            stickiness: editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      }
    }
    decorations.set(model, model.deltaDecorations(decorations.get(model) || [], list));
  }

  function decorateAll() {
    const seen = new Set();
    for (const t of ide.tabs) {
      if (t.kind !== 'file' || !t.model || seen.has(t.model)) continue;
      seen.add(t.model);
      decorate(t.model, t.path);
    }
  }
  ide.on('fileOpened', (tab) => tab?.kind === 'file' && decorate(tab.model, tab.path));

  function setShown(value) {
    shown = value;
    ide.settings.set(SHOW_KEY, value);
    decorateAll();
    render();
    ide.refreshTree?.();
  }

  function describeLine(f, line) {
    const state = lineState(f, line);
    if (state === 'partial') {
      const [taken, total] = f.partial.get(line);
      return tr('Covered {taken}/{total} branches', { taken, total });
    }
    return state === 'hit' ? tr('Covered') : tr('Not covered');
  }

  // Clicking a stripe shows what it means, like PyCharm's coverage gutter popup.
  ide.onEditor((ed) => ed.onMouseDown((e) => {
    if (!suite || !shown || e.target.type !== ide.monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    if (!e.target.element?.classList.contains('cov-line')) return;
    const path = ide.tabs.find((t) => t.model === ed.getModel())?.path;
    const f = path && suite.files.get(key(path));
    const line = e.target.position?.lineNumber;
    if (!f || !line || !lineState(f, line)) return;
    ide.ui.contextMenu(e.event.posx, e.event.posy, [
      { header: describeLine(f, line) },
      { label: tr('Hide Coverage'), run: () => setShown(false) },
      { label: tr('Show Coverage Tool Window'), icon: 'coverage', run: () => { tw.show(); revealNode(suite.nodes.get(key(path))); } },
    ]);
  }));

  // ---------- project tree: "82% lines covered" next to measured files and folders ----------
  ide.registerTreeDecorator((entry) => {
    const node = shown && suite?.nodes.get(key(entry.path));
    const pc = node && percent(node.stats.covered, node.stats.statements);
    return pc === null || !node ? null : { badge: tr('{percent}% lines covered', { percent: pc }) };
  });

  // ---------- Coverage tool window ----------
  let header;
  let list;
  let selected = null;
  const collapsed = new Set();

  // registerToolWindow calls mount right away, before it returns, so mount keeps the tool window it is given.
  let tw = null;
  ide.registerToolWindow({
    id: 'Coverage', title: tr('Coverage'), iconName: 'coverage', icon: '⛨', side: 'bottom', order: 65,
    mount(container, toolWindow) {
      tw = toolWindow;
      container.classList.add('cov-tool');
      header = el('div', 'cov-header');
      const columns = el('div', 'cov-row cov-columns');
      columns.append(el('span', 'cov-name', tr('Element')), el('span', 'cov-pc', tr('Line, %')), el('span', 'cov-pc', tr('Branch, %')));
      list = el('div', 'cov-list');
      list.tabIndex = 0;
      list.onkeydown = onKey;
      container.append(header, columns, list);
      render();
    },
  });

  function cell(covered, total) {
    const pc = percent(covered, total);
    const c = el('span', 'cov-pc', pc === null ? '—' : `${pc}% (${covered}/${total})`);
    if (pc !== null) c.dataset.percent = pc;
    return c;
  }

  const sortedChildren = (n) => [...n.children.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  function visibleRows() {
    const rows = [];
    const walk = (n, depth) => {
      rows.push([n, depth]);
      if (n.dir && !collapsed.has(key(n.path))) for (const c of sortedChildren(n)) walk(c, depth + 1);
    };
    if (suite) walk(suite.root, 0);
    return rows;
  }

  function render() {
    if (!list) return;
    renderActions();
    if (!suite) {
      header.replaceChildren(el('span', 'muted', tr('No coverage results. Run a configuration with coverage to see them here.')));
      list.replaceChildren();
      return;
    }
    const total = suite.root.stats;
    const summary = [tr('{percent}% lines covered', { percent: percent(total.covered, total.statements) ?? 0 })];
    if (total.branches) summary.push(tr('{percent}% branches covered', { percent: percent(total.coveredBranches, total.branches) }));
    const name = el('span', 'cov-suite', suite.name);
    name.dataset.userText = '';
    header.replaceChildren(name, el('span', 'cov-time', suite.time.toLocaleTimeString()), el('span', 'cov-summary', summary.join(', ')));
    if (!shown) header.appendChild(el('span', 'cov-hidden muted', tr('Hidden in editors')));
    const frag = document.createDocumentFragment();
    for (const [n, depth] of visibleRows()) {
      const row = el('div', `cov-row cov-item${n === selected ? ' selected' : ''}`);
      row.dataset.path = n.path;
      row.dataset.kind = n.dir ? 'dir' : 'file';
      const name = el('span', 'cov-name');
      name.style.paddingLeft = `${depth * 16 + 4}px`;
      const arrow = el('span', 'cov-arrow', n.dir ? (collapsed.has(key(n.path)) ? '▸' : '▾') : '');
      arrow.onclick = (e) => { e.stopPropagation(); toggle(n); };
      const label = el('span', 'cov-label', n.name);
      label.dataset.userText = '';
      name.append(arrow, el('span', `cov-icon ${n.dir ? 'dir' : 'file'}`), label);
      row.append(name, cell(n.stats.covered, n.stats.statements), cell(n.stats.coveredBranches, n.stats.branches));
      row.onclick = () => { selected = n; markSelected(list, row); };
      row.ondblclick = () => open(n);
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
  }

  // Marks a row selected in place, so the second click of a double-click lands on the same element.
  function markSelected(host, row) {
    host.querySelector('.selected')?.classList.remove('selected');
    row.classList.add('selected');
    host.focus();
  }

  function renderActions() {
    tw.setActions([
      ...(suite ? [{ icon: '⟳', title: tr("Rerun '{name}' with Coverage", { name: suite.name }), run: () => run.runConfig(suite.cfg, { executor: 'Coverage' }) }] : []),
      { icon: shown ? '◉' : '○', title: shown ? tr('Hide Coverage') : tr('Show Coverage in Editors'), run: () => setShown(!shown) },
    ]);
  }

  function toggle(n) {
    const k = key(n.path);
    if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
    render();
  }

  function open(n) {
    if (n && !n.dir) ide.openFile(n.path);
  }

  function revealNode(n) {
    if (!n) return;
    for (let p = n.parent; p; p = p.parent) collapsed.delete(key(p.path));
    selected = n;
    render();
    list.querySelector('.cov-item.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    const rows = visibleRows();
    const i = rows.findIndex(([n]) => n === selected);
    const n = selected;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) revealNode(next[0]);
    } else if (e.key === 'ArrowRight' && n?.dir && collapsed.has(key(n.path))) toggle(n);
    else if (e.key === 'ArrowLeft' && n?.dir && !collapsed.has(key(n.path))) toggle(n);
    else if (e.key === 'ArrowLeft' && n?.parent) revealNode(n.parent);
    else if ((e.key === 'Enter' || e.key === 'F4') && n && !n.dir) {
      e.preventDefault();
      e.stopPropagation();
      open(n);
    }
  }

  // ---------- actions ----------
  ide.registerAction({ id: 'RunCoverage', title: tr('Run with Coverage'), run: () => run.runSelected({ executor: 'Coverage' }) });
  ide.registerAction({ id: 'HideCoverage', title: tr('Hide Coverage'), when: () => shown, run: () => setShown(false) });
  ide.registerAction({ id: 'ShowCoverage', title: tr('Show Coverage in Editors'), when: () => !shown, run: () => setShown(true) });
  ide.on('projectOpened', () => { suite = null; selected = null; decorateAll(); render(); });

  ide.coverage = {
    suite: () => suite && { name: suite.name, files: [...suite.files.values()].map((f) => ({ ...f, executed: [...f.executed], missing: [...f.missing], partial: Object.fromEntries(f.partial) })) },
    shown: () => shown,
    setShown,
  };
})();
