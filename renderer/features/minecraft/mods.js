// A server's mods or plugins in its settings tab (main/minecraft/mods.js reads the jars: minecraft:mods): each with a
// switch that turns it off and on (the jar is renamed to .jar.disabled and back; the server is stopped first), and
// above the list what the jars say about each other: a mod that needs one that is missing, turned off or of another
// version, two that do not work together, the same mod twice, one made for another loader or another Minecraft. Each
// problem comes with what can be done about it. The check runs by itself when the section opens, after every switch,
// and when the server starts: then a notification names how many problems there are and opens this section.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const keyOf = (dir) => dir.toLowerCase();
  const notify = (o) => ide.notifications?.notify({ group: 'Minecraft', raw: true, ...o });
  const baseName = (file) => file.split('/').pop().replace(/\.disabled$/i, '');
  const FAMILY = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', bukkit: 'Paper', velocity: 'Velocity', quilt: 'Quilt' };
  const range = (p) => (p.range && p.range !== '*' ? ` ${p.range}` : '');

  // A problem in words, and what its button does: {text, action: {label, run}}.
  function explain(p, { plugins, srv, toggle }) {
    const off = (file, name) => ({ label: tr('Turn Off {name}', { name }), run: () => toggle(file, false) });
    const text = {
      missing: () => tr('{mod} needs {need}, which is not installed.', { mod: p.mod, need: `${p.need}${range(p)}` }),
      disabled: () => tr('{mod} needs {other}, which is turned off.', { mod: p.mod, other: p.other }),
      version: () => tr('{mod} needs {need}, but {have} is installed.', { mod: p.mod, need: `${p.other || p.need}${range(p)}`, have: p.have || '?' }),
      breaks: () => tr('{mod} does not work with {other}.', { mod: p.mod, other: `${p.other} ${p.have || ''}`.trim() }),
      conflicts: () => tr('{mod} may have problems with {other}.', { mod: p.mod, other: `${p.other} ${p.have || ''}`.trim() }),
      duplicate: () => tr('{mod} is here twice: {files}. A server does not start with two copies.', { mod: p.mod, files: p.files.map(baseName).join(', ') }),
      loader: () => tr('{mod} is made for {loaders}, not for this {family} server.', { mod: p.mod, loaders: p.loaders.map((l) => FAMILY[l] || l).join(', ') || '?', family: FAMILY[srv.family] || '' }),
      minecraft: () => tr('{mod} is for Minecraft {range}, and this server is {have}.', { mod: p.mod, range: p.range, have: p.have }),
      java: () => tr('{mod} needs Java {range}, and this server runs Java {have}.', { mod: p.mod, range: p.range, have: p.have }),
      loaderVersion: () => tr('{mod} needs {need}, and this server has {have}.', { mod: p.mod, need: `${p.need}${range(p)}`, have: p.have }),
      client: () => tr('{mod} is for the game only: on a server it does nothing, and some stop it from starting.', { mod: p.mod }),
      unreadable: () => (plugins ? tr('{mod} could not be read as a plugin.', { mod: p.mod }) : tr('{mod} could not be read as a mod.', { mod: p.mod })),
    }[p.code]?.() || p.code;
    const action = {
      missing: () => ({ label: tr('Find in Market'), run: () => mc.market?.open({ type: plugins ? 'plugin' : 'mod', server: srv.srv, query: p.need }) }),
      disabled: () => ({ label: tr('Turn On {name}', { name: p.other }), run: () => toggle(p.otherFile, true) }),
      breaks: () => off(p.file, p.mod),
      duplicate: () => off(p.files[1], baseName(p.files[1])),
      loader: () => off(p.file, p.mod),
      minecraft: () => off(p.file, p.mod),
      client: () => off(p.file, p.mod),
    }[p.code]?.() || null;
    return { text, action };
  }
  const count = (list, level) => list.filter((p) => p.level === level).length;
  function summary(r, plugins) {
    const n = r.items.filter((i) => i.enabled).length;
    const errors = count(r.problems, 'error');
    const warns = count(r.problems, 'warn');
    if (!r.items.length) return plugins ? tr('No plugins yet. The Market installs them.') : tr('No mods yet. The Market installs them.');
    if (errors) return tr('{n} problems that can stop the server from starting.', { n: errors });
    if (warns) return tr('Nothing that stops the server, {n} things to know.', { n: warns });
    return plugins ? tr('No problems found among {n} plugins.', { n }) : tr('No problems found among {n} mods.', { n });
  }

  // ---------- the settings tab's section ----------
  function settingsControl(srv) {
    const plugins = !srv.mods;
    const box = el('div', 'mcset-mods');
    const head = el('div', 'mcset-mods-head');
    const state = el('div', 'mcset-mods-summary');
    const recheck = el('button', 'secondary mcset-mods-recheck', tr('Check Again'));
    recheck.type = 'button';
    const problems = el('div', 'mcset-mods-problems');
    const list = el('div', 'mcset-mods-list');
    const status = el('div', 'mcset-desc muted mcset-mods-status');
    head.append(state, recheck);
    box.append(head, problems, list, status);
    let turn = 0;

    function paint(r) {
      const ctx = { plugins, srv: { srv, family: r.family }, toggle };
      state.textContent = summary(r, plugins);
      state.className = `mcset-mods-summary ${count(r.problems, 'error') ? 'bad' : count(r.problems, 'warn') ? 'warn' : r.items.length ? 'ok' : 'muted'}`;
      problems.replaceChildren(...r.problems.map((p) => {
        const x = explain(p, ctx);
        const line = el('div', `mcset-mods-problem ${p.level}`);
        line.dataset.code = p.code;
        line.append(el('span', 'mcset-mods-mark', p.level === 'error' ? '!' : 'i'), el('div', 'mcset-mods-text', x.text));
        if (x.action) {
          const b = el('button', 'secondary mcset-mods-fix', x.action.label);
          b.type = 'button';
          b.onclick = () => x.action.run();
          line.append(b);
        }
        return line;
      }));
      const bad = new Map();
      for (const p of r.problems) for (const f of [p.file, ...(p.files || [])]) if (f && (bad.get(f) !== 'error')) bad.set(f, p.level);
      list.replaceChildren(...r.items.map((i) => {
        const row = el('div', `mcset-mods-row${i.enabled ? '' : ' off'}${bad.has(i.file) ? ` ${bad.get(i.file)}` : ''}`);
        row.dataset.file = i.file;
        const sw = el('label', 'mcset-switch');
        const c = el('input');
        c.type = 'checkbox';
        c.checked = i.enabled;
        c.title = i.enabled ? tr('On: the server loads it') : tr('Off: the server does not load it');
        c.onchange = () => toggle(i.file, c.checked);
        sw.append(c, el('span', 'mcset-knob'));
        const text = el('div', 'mcset-mods-name');
        const title = el('div', 'mcset-label');
        title.append(i.name, ...(i.version ? [el('span', 'muted mcset-mods-version', i.version)] : []), ...(i.enabled ? [] : [el('span', 'mcc-chip mcset-mods-off', tr('Turned off'))]),
          ...(i.more ? [el('span', 'muted mcset-mods-version', tr('and {n} more in this file', { n: i.more }))] : []));
        text.append(title, el('div', 'mcset-desc muted', baseName(i.file)));
        row.append(sw, text);
        return row;
      }));
    }
    // keep: the list is read again after a switch that was refused, to put the switch back; what was said about the
    // refusal stays (cleared with the rest, it was gone before it could be read).
    async function load(keep) {
      const mine = ++turn;
      try {
        const r = await ide.api.invoke('minecraft:mods', ide.root, srv.dir);
        if (mine === turn) { paint(r); if (!keep) status.textContent = ''; }
      } catch (err) { if (mine === turn) status.textContent = mc.errorText(err); }
    }
    async function toggle(file, on) {
      const mine = ++turn;
      try {
        const r = await ide.api.invoke('minecraft:toggleMod', ide.root, srv.dir, file, on);
        if (mine !== turn) return;
        paint(r);
        status.textContent = on ? tr('{name} is on. It loads when the server starts.', { name: baseName(file) }) : tr('{name} is off. Its file stays in the folder.', { name: baseName(file) });
        mc.refresh?.();
      } catch (err) {
        if (mine !== turn) return;
        status.textContent = err.code === 'running' || /Stop .* first/.test(err.message || '')
          ? tr('Stop {name} first: while it runs, Java holds its files, and a mod cannot be turned on or off.', { name: srv.name }) : mc.errorText(err);
        load(true);
      }
    }
    recheck.onclick = () => ide.ui.working(recheck, load());
    load();
    return box;
  }

  // The server's settings tab, at this section.
  function show(srv) {
    mc.serverSettings(srv);
    const page = () => document.querySelector(`.custom-tab.mcset:not(.hidden) .mcset-page[data-section="${srv.mods ? 'mods' : 'plugins'}"]`);
    let tries = 0;
    const go = () => { const p = page(); if (p) p.click(); else if (++tries < 40) setTimeout(go, 100); };
    go();
  }

  // ---------- when a server starts ----------
  ide.api.on('minecraft:health', async (e) => {
    if (e.event !== 'started') return;
    const srv = mc.servers().find((s) => keyOf(s.dir) === keyOf(e.dir));
    if (!srv || (!srv.mods && !srv.plugins)) return;
    const r = await ide.api.invoke('minecraft:mods', ide.root, srv.dir).catch(() => null);
    const errors = r ? r.problems.filter((p) => p.level === 'error') : [];
    if (!errors.length) return;
    const ctx = { plugins: !srv.mods, srv: { srv, family: r.family }, toggle: () => {} };
    notify({
      title: srv.mods ? tr('{name}: {n} mod problems', { name: srv.name, n: errors.length }) : tr('{name}: {n} plugin problems', { name: srv.name, n: errors.length }),
      text: errors.slice(0, 3).map((p) => explain(p, ctx).text).join('\n'), kind: 'warn',
      actions: [{ label: tr('Show'), run: (n) => { n.expire(); show(srv); } }],
    });
  });

  mc.mods = { settingsControl, show };
})();
