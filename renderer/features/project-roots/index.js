// PyCharm's Mark Directory As: Sources Root, Test Sources Root and Excluded from the project tree's context menu, the
// roots' folder icons, the src layout's root marked when a project opens (with PyCharm's notification), and
// ide.projectRoots for other features. The roots live in main (main/features/project-roots.js), where Run, the test
// runner and Pyright read them.
(() => {
  const { joinPath, samePath, pathKey } = ide.util;
  const GROUP = 'Python source root detection';
  const KINDS = {
    sources: { label: () => tr('Sources Root'), unmark: () => tr('Unmark as Sources Root'), icon: 'sourceRoot' },
    tests: { label: () => tr('Test Sources Root'), unmark: () => tr('Unmark as Test Sources Root'), icon: 'testRoot' },
    excluded: { label: () => tr('Excluded'), unmark: () => tr('Cancel Exclusion'), icon: 'excludeRoot' },
  };

  // PyCharm's New UI folder drawn in each root's colors (expui/nodes/sourceRoot.svg, testRoot.svg, excludeRoot.svg of
  // the IntelliJ Platform, Apache License 2.0), added to the file icon table so ide.fileIcon draws them by type.
  const FOLDER = 'M8.15132 4.35836L8.29689 4.5H8.5H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.919 13.9104 13.5 13.25 13.5H2.75C2.08955 13.5 1.5 12.919 1.5 12.1333V3.86667C1.5 3.08099 2.08955 2.5 2.75 2.5H6.03823C6.16847 2.5 6.29357 2.55082 6.38691 2.64164L8.15132 4.35836Z';
  const COLORS = {
    sourceRoot: { light: ['#E7EFFD', '#3574F0'], dark: ['#25324D', '#548AF7'] },
    testRoot: { light: ['#F2FCF3', '#208A3C'], dark: ['#253627', '#57965C'] },
    excludeRoot: { light: ['#FCE9D9', '#F28C35'], dark: ['#45322B', '#C77D55'] },
  };
  const icons = (window.PYIDE_FILE_ICONS ||= { light: {}, dark: {} });
  for (const [type, variants] of Object.entries(COLORS)) {
    for (const [variant, [fill, stroke]] of Object.entries(variants)) {
      (icons[variant] ||= {})[type] = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${FOLDER}" fill="${fill}" stroke="${stroke}"/></svg>`;
    }
  }

  let roots = { sources: [], tests: [], excluded: [] }; // relative to ide.root
  let byPath = new Map(); // pathKey of each marked folder -> kind
  const absolute = (rels) => (ide.root ? rels.map((r) => (r ? joinPath(ide.root, r) : ide.root)) : []);
  const kindOf = (path) => byPath.get(pathKey(path)) || null;

  function apply(next) {
    const marked = byPath.size;
    roots = { sources: next?.sources || [], tests: next?.tests || [], excluded: next?.excluded || [] };
    byPath = new Map(Object.keys(KINDS).flatMap((k) => absolute(roots[k]).map((p) => [pathKey(p), k])));
    // The tree draws icons from byPath; it is drawn again only when some folder's icon may differ.
    if (ide.root && (marked || byPath.size)) ide.refreshTree();
    ide.emit('projectRootsChanged', api.get());
  }

  // kind: 'sources' | 'tests' | 'excluded', or null to unmark. -> false when main refused (outside the project, the
  // project root as Excluded).
  async function mark(path, kind) {
    if (!ide.root) return false;
    const next = await ide.api.invoke('project-roots:mark', ide.root, path, kind);
    if (!next) return false;
    apply(next);
    return true;
  }

  // PyCharm's "'src' has been marked as source root" with Ok, Revert and Don't show again (its group can be muted).
  function notifyDetected(rel) {
    if (!ide.notifications?.notify) return;
    const folder = joinPath(ide.root, rel);
    const root = ide.root;
    const current = () => samePath(ide.root, root);
    ide.notifications.notify({
      title: tr("'{name}' has been marked as source root", { name: rel }), kind: 'info', group: GROUP,
      actions: [
        { label: tr('Ok'), run: (n) => n.expire() },
        { label: tr('Revert'), valid: current, run: (n) => { n.expire(); mark(folder, null); } },
        { label: tr("Don't show again"), run: (n) => { n.expire(); ide.notifications.setGroupHidden?.(GROUP, true); } },
      ],
    });
  }

  ide.on('projectOpened', async (root) => {
    const r = await ide.api.invoke('project-roots:get', root);
    if (!samePath(ide.root, root)) return;
    apply(r);
    if (r.detected) notifyDetected(r.detected);
  });
  ide.on('projectClosed', () => apply(null));

  ide.registerTreeDecorator((entry) => {
    if (!entry.dir || entry.treeRoot || !byPath.size) return null;
    const kind = kindOf(entry.path);
    return kind ? { iconType: KINDS[kind].icon } : null;
  });

  // Mark Directory As › on folders of the project (core puts it right after New ›).
  ide.treeNewItems.push((entry) => {
    if (!entry.dir || !ide.root) return [];
    const isRoot = samePath(entry.path, ide.root);
    const current = kindOf(entry.path);
    const items = [
      ...(current ? [{ label: KINDS[current].unmark(), run: () => mark(entry.path, null) }] : []),
      ...Object.keys(KINDS).filter((k) => k !== current && !(k === 'excluded' && isRoot))
        .map((k) => ({ label: KINDS[k].label(), run: () => mark(entry.path, k) })),
    ];
    return [{ label: tr('Mark Directory As'), submenu: items }];
  });

  const api = {
    // Relative to the project root: {sources, tests, excluded}.
    get: () => JSON.parse(JSON.stringify(roots)),
    sourceRoots: () => absolute(roots.sources),
    testRoots: () => absolute(roots.tests),
    excludedRoots: () => absolute(roots.excluded),
    // 'sources' | 'tests' | 'excluded' | null for a folder itself (not its subfolders).
    kindOf,
    // true for a path inside an excluded folder.
    isExcluded: (path) => absolute(roots.excluded).some((d) => ide.util.isUnder(path, d)),
    mark,
  };
  ide.projectRoots = api;
})();
