// Minecraft projects in New Project (core project-wizard.js): a server, a mod or a plugin, each a new project with
// its server in servers/ (and the mod in mods/ or the plugin in plugins/). The wizard only makes the folder; once the
// project is open the Minecraft screen shows and the server, then the mod or plugin, are made as from the Minecraft
// window, their downloads in the Run window. A mod or plugin comes with a server of its loader and version to run on.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const EULA = 'https://aka.ms/MinecraftEULA';
  const MEMORY = ['1G', '2G', '4G', '6G', '8G'];
  const KINDS = { server: null, mod: ['fabric', 'forge', 'neoforge'], plugin: ['paper', 'purpur', 'velocity'] };
  const DEFAULT_KIND = { server: 'paper', mod: 'fabric', plugin: 'paper' };
  const words = (n) => n.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const serverName = (n) => { const s = n.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32) || 'server'; return mc.reserved(s) ? `${s}-server` : s; };
  const modId = (n) => words(n).join('_').toLowerCase().replace(/^[^a-z]+/, '').slice(0, 64) || 'mymod';
  const className = (n) => words(n).map((w) => w[0].toUpperCase() + w.slice(1)).join('').replace(/^[^A-Z]+/, '').slice(0, 40) || 'MyPlugin';

  function minecraftForm(what) {
    return ({ name }) => {
      const root = el('div', 'np-mc');
      const field = (label, control) => {
        const r = el('label', 'field');
        const box = el('div', 'field-row');
        box.append(control);
        r.append(el('span', null, label), box);
        return r;
      };
      const control = (tag, id, value = '') => { const c = el(tag); c.id = id; if (tag === 'input') c.value = value; return c; };
      const kind = control('select', `npMc-${what}-kind`);
      const version = control('select', `npMc-${what}-version`);
      const memory = control('select', `npMc-${what}-memory`);
      for (const m of MEMORY) memory.add(new Option(m, m));
      memory.value = what === 'server' ? '2G' : '4G';
      const port = control('input', `npMc-${what}-port`, '25565');
      const id = control('input', `npMc-${what}-id`);
      const display = control('input', `npMc-${what}-display`);
      const pkg = control('input', `npMc-${what}-pkg`);
      // The ids follow the project name until the user types one of their own.
      let auto = true;
      const follow = () => {
        if (!auto) return;
        const n = name() || 'minecraft';
        id.value = what === 'mod' ? modId(n) : className(n);
        display.value = n;
        pkg.value = `com.example.${(what === 'mod' ? modId(n) : className(n).toLowerCase()).replace(/[^a-z0-9_]/g, '')}`;
      };
      for (const c of [id, display, pkg]) c.addEventListener('input', () => { auto = false; });
      document.getElementById('npName')?.addEventListener('input', follow);
      const eula = el('input');
      eula.type = 'checkbox';
      eula.id = `npMc-${what}-eula`;
      const eulaRow = el('label', 'np-check');
      const link = el('a', null, tr('Minecraft EULA'));
      link.href = '#';
      link.onclick = (e) => { e.preventDefault(); ide.api.invoke('shell:openExternal', EULA); };
      const agree = el('span');
      agree.append(document.createTextNode(`${tr('I agree to the')} `), link);
      eulaRow.append(eula, agree);
      const note = el('div', 'np-preview muted');
      const proxy = () => kind.value === 'velocity';
      const describe = () => {
        eulaRow.classList.toggle('hidden', proxy());
        note.textContent = what === 'mod' ? tr('The mod starts from the loader\'s official template, renamed to its id and package, and comes with a server of that loader and version to run and test it on. Its first Gradle build downloads Minecraft and takes several minutes.')
          : what === 'plugin' ? tr('The plugin comes with a server of that type and version: start it once, then Build and Deploy compiles the plugin against it.')
            : tr('The server is made in servers/ with the Java its version needs; the Minecraft screen then runs, shares and fills it from the Market.');
      };
      async function loadVersions() {
        version.replaceChildren(new Option(tr('Loading…'), ''));
        version.disabled = true;
        try {
          const vs = await ide.api.invoke('minecraft:versions', kind.value);
          version.replaceChildren(...vs.map((v) => new Option(v, v)));
        } catch (err) {
          version.replaceChildren(new Option(tr('Could not load the versions'), ''));
          note.textContent = mc.errorText(err);
        }
        version.disabled = false;
      }
      kind.onchange = () => { describe(); loadVersions(); if (proxy() && what === 'server') port.value = '25577'; };
      ide.api.invoke('minecraft:kinds').then((all) => {
        for (const k of all.filter((x) => !KINDS[what] || KINDS[what].includes(x.id))) kind.add(new Option(k.title, k.id));
        kind.value = DEFAULT_KIND[what];
        describe();
        loadVersions();
      });
      root.append(field(what === 'mod' ? tr('Loader:') : tr('Type:'), kind), field(tr('Version:'), version));
      if (what === 'mod') root.append(field(tr('Mod id:'), id), field(tr('Mod name:'), display), field(tr('Package:'), pkg));
      if (what === 'plugin') root.append(field(tr('Plugin name:'), id), field(tr('Package:'), pkg));
      root.append(field(tr('Memory:'), memory));
      if (what === 'server') root.append(field(tr('Port:'), port));
      root.append(note, eulaRow);
      follow();

      return {
        el: root,
        files: () => ({}),
        // What servers download or write as they run, and Gradle's output; the server settings and worlds stay.
        gitignore: 'servers/*/*.jar\nservers/*/libraries/\nservers/*/versions/\nservers/*/cache/\nservers/*/logs/\nbuild/\n.gradle/\nrun/\n',
        async validate() {
          follow();
          if (!version.value) throw new Error(tr('Choose a version.'));
          if (!proxy() && !eula.checked) throw new Error(tr('A Minecraft server runs only after you accept the Minecraft EULA.'));
          if (what === 'mod' && !/^[a-z][a-z0-9_]{1,63}$/.test(id.value.trim())) throw new Error(tr('Use a mod id of lower-case letters, digits and _, starting with a letter.'));
          if (what === 'plugin' && !/^[A-Z][A-Za-z0-9]{0,39}$/.test(id.value.trim())) throw new Error(tr('Use a class-style plugin name: a capital letter, then letters and digits.'));
          if (what !== 'server' && mc.reserved(id.value.trim())) throw new Error(tr('{name} is a name Windows keeps for a device: choose another.', { name: id.value.trim() }));
          if (what !== 'server' && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(pkg.value.trim())) throw new Error(tr('Use a Java package such as com.example.mymod.'));
          const p = Number(port.value.trim() || 25565);
          if (what === 'server' && (!Number.isInteger(p) || p < 1 || p > 65535)) throw new Error(tr('Use a port from 1 to 65535.'));
        },
        async opened() {
          mc.screen.show('servers');
          const srv = await mc.createServer({ name: what === 'server' ? serverName(name()) : 'server', kind: kind.value, mc: version.value, memory: memory.value, port: Number(port.value) || 25565 });
          if (!srv) return;
          if (what === 'mod') await mc.createMod({ id: id.value.trim(), display: display.value.trim(), pkg: pkg.value.trim(), server: srv.name });
          if (what === 'plugin') await mc.createPlugin({ name: id.value.trim(), pkg: pkg.value.trim(), server: srv.name }).catch((err) => ide.ui.alert(mc.errorText(err)));
        },
      };
    };
  }

  const icon = (glyph) => () => el('span', 'np-mc-icon', glyph);
  (ide.projectTypes ||= []).push(
    { id: 'minecraft-mod', name: () => tr('Minecraft Mod'), icon: icon('⚙'), defaultName: 'mymod', form: minecraftForm('mod') },
    { id: 'minecraft-plugin', name: () => tr('Minecraft Plugin'), icon: icon('🧩'), defaultName: 'MyPlugin', form: minecraftForm('plugin') },
    { id: 'minecraft-server', name: () => tr('Minecraft Server'), icon: icon('⛏'), defaultName: 'minecraft-server', form: minecraftForm('server') },
  );
})();
