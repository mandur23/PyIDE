// Vulnerable packages, like PyCharm's "Vulnerable declared dependency" inspection: the packages of the project
// interpreter and the versions the dependency files stand for (pins, lock files, else what is installed) are looked
// up in the OSV database by the main process (main/features/vulnerabilities.js). Vulnerable packages get a ⚠ in the
// Python Packages window with their advisories and "Upgrade to <fixed version>"; vulnerable requirement lines get a
// warning (problems source 'vulnerabilities') with the quick fix "Upgrade to <fixed version>", which edits the spec.
// Automatic checks follow the package list and the dependency check, at most once a day per package@version (the
// main process caches); "Check for Vulnerabilities" asks again. In Safe Mode only the manual check goes online.
(() => {
  const { el, samePath } = ide.util;
  const { monaco } = ide;
  const SOURCE = 'vulnerabilities';
  const SETTING = 'packages.vulnerabilityCheck';
  const enabled = () => ide.settings.get(SETTING, true) !== false;
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  const keyOf = (name, version) => `${norm(name)}@${String(version).trim().toLowerCase()}`;
  const userText = (n) => { n.dataset.userText = ''; return n; };
  const countText = (n) => (n === 1 ? tr('1 known vulnerability') : tr('{count} known vulnerabilities', { count: n }));

  const EMPTY = { packages: [], requirements: [] };
  let result = EMPTY;
  let byKey = new Map(); // keyOf(name, version) -> {name, version, vulns, fixed}
  let flagged = new Set(); // paths with problems set
  let lastShown = '[]'; // what the Packages window marks, as JSON
  let seq = 0;
  let timer = null;

  // ---------- status note in the Python Packages window ----------
  const note = el('div', 'vuln-status');
  note.id = 'vulnStatus';
  ide.packages.notes()?.appendChild(note);
  function setNote(kind, text, detail, action) {
    note.replaceChildren();
    note.dataset.kind = kind || '';
    if (!text) return;
    note.appendChild(el('span', 'vuln-status-text', text));
    if (detail) note.appendChild(userText(el('span', 'vuln-status-detail', ` ${detail}`)));
    if (action) {
      const b = el('button', 'link', action.label);
      b.onclick = action.run;
      note.appendChild(b);
    }
  }

  // ---------- the check ----------
  // manual: the user asked (Check for Vulnerabilities): online even in Safe Mode or with the setting off, and
  // ignoring the cache.
  async function check({ manual = false } = {}) {
    clearTimeout(timer);
    if (!manual && !enabled()) { apply(EMPTY); setNote(); return result; }
    const my = ++seq;
    const network = manual || ide.trusted !== false;
    const dep = ide.dependencies?.state() || { files: [] };
    const installed = ide.packages.list().map((p) => ({ name: p.name, version: p.version }));
    if (manual) setNote('busy', tr('Checking for vulnerabilities…'));
    let r;
    try {
      r = await ide.api.invoke('vulnerabilities:check', { root: ide.root, installed, files: dep.files || [], lock: dep.lock || null, network, force: manual });
    } catch (err) { r = { ...EMPTY, error: err.message }; }
    if (my !== seq) return result;
    apply(r);
    if (r.error) {
      ide.log.warn(`vulnerabilities: ${r.error}`);
      setNote('error', tr('Could not check for vulnerabilities:'), r.error, { label: tr('Retry'), run: () => check({ manual: true }) });
    } else if (!network && r.unknown) {
      setNote('safe', tr('Safe Mode: packages are not checked for vulnerabilities automatically.'), '', { label: tr('Check for Vulnerabilities'), run: () => check({ manual: true }) });
    } else if (manual) {
      setNote('done', r.packages.length
        ? (r.packages.length === 1 ? tr('1 vulnerable package found') : tr('{count} vulnerable packages found', { count: r.packages.length }))
        : tr('No known vulnerabilities found'));
    } else setNote();
    return result;
  }
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(() => check(), ms); };

  function problemText(r, pkg) {
    const head = pkg.vulns.length === 1
      ? tr("Vulnerable dependency: '{name}' {version} has 1 known vulnerability", { name: r.name, version: r.version })
      : tr("Vulnerable dependency: '{name}' {version} has {count} known vulnerabilities", { name: r.name, version: r.version, count: pkg.vulns.length });
    const lines = pkg.vulns.map((v) => `• ${v.id}${v.aliases.length ? ` (${v.aliases.join(', ')})` : ''}${v.summary ? `: ${v.summary}` : ''}`);
    return [head, ...lines, pkg.fixed ? tr('Fixed in {version}', { version: pkg.fixed }) : tr('No fixed version is known')].join('\n');
  }

  function apply(r) {
    result = { packages: r.packages || [], requirements: r.requirements || [] };
    byKey = new Map(result.packages.map((p) => [keyOf(p.name, p.version), p]));
    const files = new Map();
    for (const req of result.requirements) {
      const pkg = byKey.get(keyOf(req.name, req.version));
      if (!pkg) continue;
      if (!files.has(req.path)) files.set(req.path, []);
      files.get(req.path).push({ line: req.line, col: req.col, endCol: req.endCol, msg: problemText(req, pkg), severity: 'warning' });
    }
    for (const [p, items] of files) ide.problems.set(SOURCE, p, items);
    for (const p of flagged) if (![...files.keys()].some((n) => samePath(n, p))) ide.problems.set(SOURCE, p, []);
    flagged = new Set(files.keys());
    // Redraw the Packages window only when its marks change: a redraw replaces the rows, and one between the press
    // and the release of a click would swallow the click.
    const shown = JSON.stringify(result.packages.map((p) => [p.key, p.fixed, p.vulns.map((v) => v.id)]));
    if (shown !== lastShown) { lastShown = shown; ide.packages.render(); }
  }

  // ---------- Python Packages window ----------
  ide.packages.decorateRow((row, p) => {
    const hit = byKey.get(keyOf(p.name, p.version));
    if (!hit) return;
    row.classList.add('pkg-vulnerable');
    row.dataset.vulnerable = String(hit.vulns.length);
    const icon = el('span', 'pkg-vuln-icon', '⚠');
    icon.title = countText(hit.vulns.length);
    row.insertBefore(icon, row.firstChild);
  });

  ide.packages.addDetails((p, { busy }) => {
    const hit = byKey.get(keyOf(p.name, p.version));
    if (!hit) return null;
    const box = el('div', 'pkg-vulns');
    box.id = 'pkgVulns';
    const head = el('div', 'pkg-vulns-head');
    head.append(el('span', 'pkg-vuln-icon', '⚠'), el('span', null, countText(hit.vulns.length)));
    if (hit.fixed) {
      const up = el('button', 'secondary', tr('Upgrade to {version}', { version: hit.fixed }));
      up.id = 'pkgVulnUpgrade';
      up.disabled = busy;
      up.onclick = () => ide.packages.install(`${p.name}==${hit.fixed}`);
      head.appendChild(up);
    } else head.appendChild(el('span', 'muted', tr('No fixed version is known')));
    box.appendChild(head);
    for (const v of hit.vulns) {
      const item = el('div', 'pkg-vuln');
      item.dataset.id = v.id;
      const title = el('div', 'pkg-vuln-title');
      const link = userText(el('a', 'pkg-vuln-id', v.id));
      link.href = '#';
      link.title = v.link;
      link.onclick = (e) => { e.preventDefault(); ide.api.invoke('shell:openExternal', v.link); };
      title.appendChild(link);
      if (v.aliases.length) title.appendChild(userText(el('span', 'pkg-vuln-aliases', v.aliases.join(', '))));
      if (v.severity) title.appendChild(userText(el('span', 'pkg-vuln-sev', v.severity)));
      item.appendChild(title);
      if (v.summary) item.appendChild(userText(el('div', 'pkg-vuln-summary', v.summary)));
      item.appendChild(el('div', 'pkg-vuln-fixed muted', v.fixed.length ? tr('Fixed in {version}', { version: v.fixed.join(', ') }) : tr('No fixed version is known')));
      box.appendChild(item);
    }
    return box;
  });

  const run = () => { ide.packages.toolWindow.show(); return check({ manual: true }); };
  ide.packages.addAction({ icon: '🛡', id: 'checkVulnerabilities', title: tr('Check for Vulnerabilities'), run });
  ide.registerAction({ id: 'CheckForVulnerabilities', title: tr('Check for Vulnerabilities'), run });

  // ---------- quick fix: Upgrade to <version> ----------
  // The main process rewrites the requirement as the editor holds it now (comment, options and `\` continuation
  // lines included) and declines when there is nothing safe to offer: a clause the user wrote excludes the fixed
  // version, or --hash options that would go stale. Those lines keep the warning without a quick fix.
  const tabOf = (model) => model && ide.tabs.find((t) => t.kind === 'file' && t.model === model);
  const provider = {
    async provideCodeActions(model, range, context) {
      const tab = tabOf(model);
      if (!tab || !result.requirements.length) return undefined;
      const versionId = model.getVersionId();
      const actions = [];
      for (const r of result.requirements) {
        if (!samePath(r.path, tab.path) || r.line > model.getLineCount()) continue;
        const fixed = byKey.get(keyOf(r.name, r.version))?.fixed;
        if (!fixed) continue;
        // requirements.txt: the requirement goes on over lines that end in a backslash, as pip reads it.
        let last = r.line;
        if (r.kind === 'requirements') while (last < model.getLineCount() && /\\\s*$/.test(model.getLineContent(last))) last++;
        if (last < range.startLineNumber || r.line > range.endLineNumber) continue;
        const span = r.kind === 'requirements' ? new monaco.Range(r.line, r.col, last, model.getLineMaxColumn(last)) : new monaco.Range(r.line, r.col, r.line, r.col + r.raw.length);
        let text = null;
        try { text = await ide.api.invoke('vulnerabilities:upgrade', { kind: r.kind, text: model.getValueInRange(span), raw: r.raw, fixed }); } catch {}
        if (typeof text !== 'string' || model.isDisposed() || model.getVersionId() !== versionId) continue;
        actions.push({
          title: tr('Upgrade to {version}', { version: fixed }),
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: context.markers.filter((m) => m.source === SOURCE && m.startLineNumber === r.line),
          edit: { edits: [{ resource: model.uri, versionId, textEdit: { range: span, text } }] },
        });
      }
      return { actions, dispose() {} };
    },
  };
  for (const lang of ['plaintext', 'ini']) monaco.languages.registerCodeActionProvider(lang, provider);

  // ---------- when ----------
  ide.on('packagesListed', () => schedule(300));
  ide.on('dependenciesChecked', () => schedule(800));
  ide.on('projectClosed', () => { seq++; clearTimeout(timer); apply(EMPTY); setNote(); });
  ide.on('settingsChanged', (key) => { if (key === SETTING) schedule(0); });

  // ---------- settings ----------
  (ide.settingsPages ||= []).push({
    id: 'vulnerabilities', title: () => tr('Vulnerable Packages'), defaults: { [SETTING]: true },
    keywords: 'vulnerability vulnerable security osv cve advisory package dependency requirements 취약점 보안 패키지 의존성 요구 사항',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Vulnerable Packages'));
      s.appendChild(ctx.ui.checkbox(SETTING, tr('Check installed packages and project dependencies for known vulnerabilities')));
      s.appendChild(el('div', 'muted settings-note', tr('Package names and versions are sent to the OSV database (osv.dev), at most once a day per version. In Safe Mode nothing is sent until you use Check for Vulnerabilities.')));
    },
  });

  ide.vulnerabilities = { check, state: () => result };
})();
