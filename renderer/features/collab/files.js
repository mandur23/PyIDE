// Saving and the files of a collaboration session. A guest's Save asks the host, whose window saves the file as its own
// (encoding, save actions, the File Cache Conflict question); a guest the host lets edit makes, renames and deletes
// files and folders from its tree's menu, and the host does it on its disk (a deleted one goes to the Recycle Bin).
// Every tab follows: the host's through ide.documentsMoved, the guests' when the host tells them (moved).
(() => {
  const { basename } = ide.util;
  const C = ide.collab;
  if (!C) return;
  const api = ide.api;
  const notify = (title, text, kind = 'warn') => ide.notifications?.notify({ title, text, kind, group: tr('Collaboration') });
  const WHY = {
    readOnly: () => tr('You may only view this session: the host has not let you edit.'),
    offline: () => tr('You are not connected to the host right now.'),
    timeout: () => tr('The host did not answer in time.'),
    EEXIST: () => tr('A file or folder of that name is already there.'),
    ENOENT: () => tr('The file is not there any more.'),
    hidden: () => tr('The host does not share this file.'),
    badPath: () => tr('That name cannot be used on Windows.'),
    notOpen: () => tr('The host could not open it.'),
    protected: (r) => C.lockedText(r.why),
  };
  const why = (r) => (Object.hasOwn(WHY, String(r.code)) && WHY[r.code](r)) || r.error || tr('The host could not do it.');

  // ---------- guest ----------
  C.save = async (doc) => {
    const rel = C.relOfLocal(doc.path);
    if (rel === null) return null;
    const r = await api.invoke('collab:save', rel);
    if (!r.ok) notify(tr('{name} was not saved', { name: basename(doc.path) }), why(r));
    return null;
  };

  async function fsOp(op, args, label) {
    const r = await api.invoke('collab:fs', op, args);
    if (!r.ok) notify(label, why(r));
    return r.ok;
  }
  const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);
  const parentOf = (rel) => rel.split('/').slice(0, -1).join('/');
  async function askName(placeholder, initial = '') {
    const name = (await ide.ui.prompt(placeholder, initial))?.trim();
    if (!name) return null;
    const bad = ide.util.badName(name);
    if (bad) { ide.ui.alert(bad); return null; }
    return name;
  }
  async function create(dir, folder) {
    const name = await askName(folder ? tr('New folder name') : tr('New file name'));
    if (!name) return;
    const rel = joinRel(dir, name.replace(/\\/g, '/'));
    if (await fsOp('create', { path: rel, dir: folder }, tr('{name} was not created', { name }))) {
      if (!folder) ide.openFile(C.localPath(rel));
    }
  }
  async function rename(rel) {
    const name = await askName(tr('New name'), basename(rel));
    if (!name || name === basename(rel)) return;
    await fsOp('rename', { from: rel, to: joinRel(parentOf(rel), name) }, tr('{name} was not renamed', { name: basename(rel) }));
  }
  async function remove(rel, dir) {
    const ok = await ide.ui.confirm(dir ? tr('Delete the folder {name} and everything in it on the host\'s computer? It goes to the host\'s Recycle Bin.', { name: basename(rel) })
      : tr('Delete {name} on the host\'s computer? It goes to the host\'s Recycle Bin.', { name: basename(rel) }), { ok: tr('Delete') });
    if (ok) await fsOp('delete', { path: rel }, tr('{name} was not deleted', { name: basename(rel) }));
  }
  // The tree's menu: on a row, or on the empty space under the rows (the project's top folder).
  document.addEventListener('contextmenu', (e) => {
    const tree = e.target.closest?.('.collab-tree');
    if (!tree || C.state().role !== 'guest') return;
    e.preventDefault();
    const row = e.target.closest('.collab-tree-row');
    const rel = row?.dataset.rel ?? '';
    const isDir = !row || row.classList.contains('dir');
    const dir = isDir ? rel : parentOf(rel);
    const off = !C.canEdit();
    ide.ui.contextMenu(e.clientX, e.clientY, [
      { label: tr('New File…'), disabled: off, run: () => create(dir, false) },
      { label: tr('New Folder…'), disabled: off, run: () => create(dir, true) },
      ...(row ? [{ separator: true }, { label: tr('Rename…'), disabled: off, run: () => rename(rel) }, { label: tr('Delete…'), disabled: off, run: () => remove(rel, isDir) }] : []),
      { separator: true }, { label: tr('Refresh'), run: () => C.tree.refresh() },
    ]);
  });
  C.on('tree:changed', (e) => { if (typeof e.path === 'string') C.tree.changed(C.relOfLocal(e.path) ?? ''); });
  // The host renamed or deleted a file (a guest asked, or the host did it in its own tree): the guest's tabs follow.
  C.on('moved', (e) => {
    if (C.state().role !== 'guest' || typeof e.from !== 'string') return;
    ide.documentsMoved(C.localPath(e.from), typeof e.to === 'string' ? C.localPath(e.to) : null);
  });

  // ---------- host ----------
  C.on('save', async (e) => {
    if (C.state().role !== 'host' || typeof e.path !== 'string') return;
    const tab = ide.findTab(e.path);
    const reply = (r) => api.invoke('collab:saved', { by: e.by, req: e.req, rel: e.rel, path: e.path, ...r });
    if (!tab?.doc) return reply({ noTab: true });
    try {
      await ide.saveTab(tab);
      return reply({ ok: !ide.isDirty(tab) });
    } catch (err) { return reply({ ok: false, error: err.message }); }
  });
  C.on('moved', (e) => {
    if (C.state().role !== 'host' || typeof e.from !== 'string') return;
    ide.documentsMoved(e.from, typeof e.to === 'string' ? e.to : null);
    ide.refreshTree?.();
  });
  C.on('fsChanged', () => ide.refreshTree?.());
  // What the host does in its own tree, or what changes on its disk, reaches the guests' trees and tabs.
  ide.on('filesChanged', (c) => {
    if (C.state().role === 'host') api.send('collab:filesChanged', { created: c?.created || [], deleted: c?.deleted || [], renamed: c?.renamed || [] });
  });
  api.on('watch:changed', ({ root, paths } = {}) => {
    if (C.state().role === 'host' && root && ide.root && ide.util.samePath(root, ide.root) && Array.isArray(paths)) api.send('collab:filesChanged', { changed: paths.slice(0, 500) });
  });
})();
