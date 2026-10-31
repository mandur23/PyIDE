// The Server Settings tab (main/minecraft/server-settings.js): one editor tab per server, its settings in sections that
// the list on the left jumps to, and a search over every setting. Changes wait in a draft until Save. A running server
// gets the player list changes as console commands at once; the rest applies when it starts again.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const tabId = (dir) => `minecraft:settings:${dir.toLowerCase()}`;
  const MEMORY = ['1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G'];
  // Minecraft's chat colors, for the message of the day preview.
  const COLORS = { 0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
    8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff' };

  const CHOICES = () => ({
    gamemode: { survival: tr('Survival'), creative: tr('Creative'), adventure: tr('Adventure'), spectator: tr('Spectator') },
    difficulty: { peaceful: tr('Peaceful'), easy: tr('Easy'), normal: tr('Normal'), hard: tr('Hard') },
    'level-type': { 'minecraft:normal': tr('Default'), 'minecraft:flat': tr('Superflat'), 'minecraft:large_biomes': tr('Large Biomes'), 'minecraft:amplified': tr('Amplified') },
    'op-permission-level': { 1: tr('1: build at the spawn'), 2: tr('2: cheat commands'), 3: tr('3: manage players'), 4: tr('4: every command') },
  });
  // [key, label, description]: a key starting with $ is a setting other than a server.properties line.
  const SECTIONS = () => [
    { id: 'general', title: tr('General'), rows: [
      ['motd', tr('Message of the day'), tr('The text under the server\'s name in the multiplayer list, up to two lines. § codes color it: §a green, §e yellow, §l bold.')],
      ['server-port', tr('Port'), tr('The port players connect to (25565 when they give none). Proxies that send players here are updated.')],
      ['max-players', tr('Max players'), tr('How many players can be on the server at once.')],
      ['$memory', tr('Memory'), tr('The most memory the server\'s Java may take (-Xmx).')],
    ] },
    { id: 'game', title: tr('Gameplay'), rows: [
      ['gamemode', tr('Game mode'), tr('The mode new players join in.')],
      ['force-gamemode', tr('Force game mode'), tr('Players are put back into that mode every time they join.')],
      ['difficulty', tr('Difficulty'), ''],
      ['hardcore', tr('Hardcore'), tr('Hard difficulty, and players who die can only watch.')],
      ['pvp', tr('PvP'), tr('Players can hurt each other.')],
      ['allow-flight', tr('Allow flight'), tr('Players who fly in survival (with a mod) are not kicked.')],
      ['allow-nether', tr('Nether'), tr('Players can travel to the Nether.')],
      ['enable-command-block', tr('Command blocks'), tr('Command blocks run their commands.')],
      ['spawn-protection', tr('Spawn protection'), tr('Within this many blocks of the spawn only operators can build. 0 turns it off.')],
    ] },
    { id: 'world', title: tr('World'), note: tr('Seed, world type and structures shape a world when it is made: to use new ones, give a new world name.'), rows: [
      ['level-name', tr('World name'), tr('The world\'s folder in the server folder. A name without a folder makes a new world.')],
      ['level-seed', tr('Seed'), tr('Empty for a random seed.')],
      ['level-type', tr('World type'), ''],
      ['generate-structures', tr('Structures'), tr('Villages, temples and other structures are generated.')],
      ['max-world-size', tr('World border radius'), tr('How far from the center the world border lies, in blocks.')],
    ] },
    { id: 'players', title: tr('Players'), rows: [
      ['online-mode', tr('Check accounts'), tr('Only players signed in to a Minecraft account can join. Off, anyone can join under any name; a server behind a proxy has it off because the proxy checks.')],
      ['white-list', tr('Whitelist'), tr('Only the players below can join.')],
      ['enforce-whitelist', tr('Enforce whitelist'), tr('Players taken off the whitelist are kicked at once.')],
      ['$whitelist', tr('Whitelisted players'), ''],
      ['$ops', tr('Operators'), tr('Players who can run commands, up to their level.')],
      ['op-permission-level', tr('Level /op gives'), ''],
      ['player-idle-timeout', tr('Idle kick (minutes)'), tr('Players idle this long are kicked. 0 never kicks.')],
      ['hide-online-players', tr('Hide who is online'), tr('The multiplayer list does not show the players on the server.')],
    ] },
    { id: 'performance', title: tr('Performance'), rows: [
      ['view-distance', tr('View distance'), tr('How many chunks around each player are sent. Lower is lighter on the server.')],
      ['simulation-distance', tr('Simulation distance'), tr('How many chunks around each player keep running: mobs, crops, redstone.')],
      ['entity-broadcast-range-percentage', tr('Entity range (%)'), tr('How far away players see mobs and other entities, against the default.')],
      ['network-compression-threshold', tr('Compression threshold'), tr('Packets bigger than this many bytes are compressed. -1 turns compression off.')],
      ['max-tick-time', tr('Watchdog (ms)'), tr('The server stops itself when one tick takes longer than this. -1 turns it off.')],
      ['sync-chunk-writes', tr('Synchronous chunk writes'), tr('Chunks are on disk before the server goes on: safer worlds, slower saves.')],
      ['rate-limit', tr('Packet limit'), tr('Players who send more packets a second than this are kicked. 0 for no limit.')],
      ['$jvm', tr('JVM options'), ''],
    ] },
    { id: 'mods', title: tr('Mods'), mods: true, rows: [['$translate', tr('Korean translation'), '']] },
    { id: 'other', title: tr('Other properties'), rows: [['$other', '', '']] },
  ];

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const listKey = (list) => list.map((p) => [p.name.toLowerCase(), p.uuid, p.level ?? null]);

  // The open tabs, whose Running/Stopped label follows the server.
  const views = new Set();
  function open(srv) {
    ide.openCustomTab({ id: tabId(srv.dir), title: tr('{name} Settings', { name: srv.name }), icon: 'settings', mount: (host) => mount(host, srv),
      onClose: () => { for (const v of views) if (v.srv.dir === srv.dir) views.delete(v); } });
  }
  function paintStates() {
    for (const v of views) {
      const chip = v.head.querySelector('.mcset-state');
      if (!chip) continue;
      const running = mc.runningAt(v.srv.dir);
      chip.classList.toggle('on', running);
      chip.textContent = running ? tr('Running') : tr('Stopped');
    }
  }

  function mount(host, srv) {
    host.classList.add('mcset');
    const v = { srv, host, base: null, draft: null, invalid: new Set() };
    const nav = el('div', 'mcset-nav');
    const search = el('input', 'input mcset-search');
    search.placeholder = tr('Search settings');
    const pages = el('div', 'mcset-pages');
    nav.append(search, pages);
    const main = el('div', 'mcset-main');
    const head = el('div', 'mcset-head');
    const scroll = el('div', 'mcset-scroll');
    const foot = el('div', 'mcset-foot');
    const status = el('span', 'mcset-status muted');
    const revert = el('button', 'secondary mcset-revert', tr('Revert'));
    const save = el('button', 'primary mcset-save', tr('Save'));
    foot.append(status, revert, save);
    main.append(head, scroll, foot);
    const body = el('div', 'mcset-body');
    body.append(nav, main);
    host.append(body);
    views.add(v);
    Object.assign(v, { nav, pages, search, head, scroll, status, revert, save });
    revert.onclick = () => { reset(v); render(v); };
    save.onclick = () => commit(v);
    search.oninput = () => filter(v);
    scroll.onscroll = () => spy(v);
    load(v);
  }

  async function load(v) {
    v.scroll.replaceChildren(el('div', 'mcset-loading muted', tr('Reading the settings…')));
    try { v.base = await ide.api.invoke('minecraft:settings', ide.root, v.srv.dir); } catch (err) {
      v.scroll.replaceChildren(el('div', 'mcset-error', mc.errorText(err)));
      return;
    }
    v.schema = new Map(v.base.schema.map((p) => [p.key, p]));
    // A missing line shows the value the server uses for it.
    for (const p of v.base.schema) v.base.props[p.key] ??= p.def;
    reset(v);
    render(v);
  }
  function reset(v) {
    v.draft = clone({ props: v.base.props, memory: v.base.memory, jvmArgs: v.base.jvmArgs, whitelist: v.base.whitelist, ops: v.base.ops });
    v.invalid.clear();
  }

  // What Save would write, and whether anything did change.
  function changes(v) {
    const props = Object.fromEntries(Object.entries(v.draft.props).filter(([k, x]) => x !== v.base.props[k]));
    return { props, memory: v.draft.memory !== v.base.memory, jvm: !same(v.draft.jvmArgs, v.base.jvmArgs),
      whitelist: !same(listKey(v.draft.whitelist), listKey(v.base.whitelist)), ops: !same(listKey(v.draft.ops), listKey(v.base.ops)) };
  }
  const changedKeys = (c) => [...Object.keys(c.props), ...(c.memory ? ['$memory'] : []), ...(c.jvm ? ['$jvm'] : []),
    ...(c.whitelist ? ['$whitelist'] : []), ...(c.ops ? ['$ops'] : [])];
  function update(v) {
    const keys = changedKeys(changes(v));
    for (const row of v.scroll.querySelectorAll('.mcset-row')) row.classList.toggle('modified', keys.includes(row.dataset.key));
    v.status.classList.remove('mcset-error');
    v.status.textContent = v.invalid.size ? tr('Fix the values marked in red to save.')
      : keys.length ? tr('{count} changed', { count: keys.length }) : '';
    v.save.disabled = !keys.length || !!v.invalid.size;
    v.revert.disabled = !keys.length;
  }
  const setProp = (v, key, value) => { v.draft.props[key] = value; update(v); };

  // ---------- layout ----------
  function render(v) {
    const { srv, base } = v;
    const running = mc.runningAt(srv.dir);
    const title = el('div', 'mcset-title');
    title.append(el('span', 'mcset-name', srv.name), el('span', `mcset-state${running ? ' on' : ''}`, running ? tr('Running') : tr('Stopped')));
    const sub = el('div', 'mcset-sub muted', `${mc.kindTitle(srv.kind)} ${srv.mc || ''} · ${tr('port {port}', { port: base.props['server-port'] || srv.port })}`);
    const tools = el('div', 'mcset-tools');
    const reload = el('button', 'secondary mcset-reload', tr('Reload'));
    reload.title = tr('Read the settings from the server\'s files again');
    reload.onclick = async () => {
      if (changedKeys(changes(v)).length && !(await ide.ui.confirm(tr('Throw away the changes not saved yet?'), { ok: tr('Reload') }))) return;
      load(v);
    };
    const file = el('button', 'secondary', base.proxy ? 'velocity.toml' : 'server.properties');
    file.onclick = () => ide.openFile(`${srv.dir}\\${base.proxy ? 'velocity.toml' : 'server.properties'}`);
    tools.append(file, reload);
    const left = el('div', 'mcset-head-text');
    left.append(title, sub);
    v.head.replaceChildren(left, tools);

    v.pages.replaceChildren();
    v.scroll.replaceChildren();
    v.sections = [];
    for (const s of SECTIONS()) {
      if (s.mods && !srv.mods) continue;
      const rows = s.rows.filter(([key]) => (base.proxy ? key === '$memory' || key === '$jvm' : key === '$other' || key.startsWith('$') || v.schema.has(key)));
      if (!rows.length) continue;
      const sec = el('section', 'mcset-section');
      sec.dataset.section = s.id;
      sec.append(el('h2', 'mcset-section-title', s.title));
      if (s.note && !base.proxy) sec.append(el('div', 'mcset-note', s.note));
      for (const [key, label, desc] of rows) {
        if (key === '$other') sec.append(...otherRows(v));
        else sec.append(row(v, key, label, desc, control(v, key)));
      }
      v.scroll.append(sec);
      const item = el('div', 'mcset-page', s.title);
      item.dataset.section = s.id;
      item.onclick = () => { v.scroll.scrollTo({ top: sec.offsetTop - v.scroll.offsetTop - 8, behavior: 'smooth' }); mark(v, s.id); };
      v.pages.append(item);
      v.sections.push({ id: s.id, sec, item });
    }
    mark(v, v.sections[0]?.id);
    filter(v);
    update(v);
  }
  function row(v, key, label, desc, ctl, wide) {
    const r = el('div', `mcset-row${wide || key.startsWith('$') && key !== '$memory' ? ' wide' : ''}`);
    r.dataset.key = key;
    const text = el('div', 'mcset-text');
    text.append(el('div', 'mcset-label', label));
    if (desc) text.append(el('div', 'mcset-desc muted', desc));
    r.dataset.search = `${label} ${desc} ${key}`.toLowerCase();
    r.append(text, ctl);
    return r;
  }
  const mark = (v, id) => { for (const s of v.sections) s.item.classList.toggle('selected', s.id === id); };
  function spy(v) {
    const top = v.scroll.scrollTop + v.scroll.offsetTop + 24;
    let cur = v.sections[0];
    for (const s of v.sections) if (!s.sec.classList.contains('hidden') && s.sec.offsetTop <= top) cur = s;
    if (cur) mark(v, cur.id);
  }
  function filter(v) {
    const words = v.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const s of v.sections || []) {
      let any = !words.length;
      for (const r of s.sec.querySelectorAll('.mcset-row')) {
        const hit = words.every((w) => r.dataset.search.includes(w));
        r.classList.toggle('hidden', !hit);
        any ||= hit;
      }
      s.sec.classList.toggle('hidden', !any);
      s.item.classList.toggle('dim', !any);
    }
  }

  // ---------- controls ----------
  function control(v, key) {
    if (key === '$memory') return memoryControl(v);
    if (key === '$jvm') return jvmControl(v);
    if (key === '$whitelist') return playerList(v, 'whitelist');
    if (key === '$ops') return playerList(v, 'ops');
    if (key === '$translate') return translation(v);
    if (key === 'motd') return motdControl(v);
    const p = v.schema.get(key);
    const value = v.draft.props[key];
    if (p.type === 'bool') return toggle(value === 'true', (on) => setProp(v, key, on ? 'true' : 'false'), key);
    if (p.type === 'choice') {
      const s = el('select', 'input mcset-input');
      const labels = CHOICES()[key] || {};
      for (const c of [...p.choices, ...(p.choices.includes(value) ? [] : [value])]) s.add(new Option(labels[c] || c, c));
      s.value = value;
      s.dataset.prop = key;
      s.onchange = () => setProp(v, key, s.value);
      return s;
    }
    const i = el('input', 'input mcset-input');
    i.dataset.prop = key;
    i.value = value;
    if (p.type === 'int') {
      i.type = 'number';
      i.min = p.min;
      i.max = p.max;
      i.oninput = () => {
        const n = Number(i.value);
        const ok = i.value.trim() !== '' && Number.isInteger(n) && n >= p.min && n <= p.max;
        i.classList.toggle('invalid', !ok);
        i.title = ok ? '' : tr('A whole number from {min} to {max}', { min: p.min, max: p.max });
        if (ok) v.invalid.delete(key); else v.invalid.add(key);
        setProp(v, key, ok ? String(n) : i.value);
      };
    } else {
      if (p.def) i.placeholder = p.def;
      i.oninput = () => setProp(v, key, i.value);
    }
    return i;
  }
  function toggle(on, change, key) {
    const t = el('label', 'mcset-switch');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = on;
    if (key) c.dataset.prop = key;
    c.onchange = () => change(c.checked);
    t.append(c, el('span', 'mcset-knob'));
    return t;
  }
  function memoryControl(v) {
    const s = el('select', 'input mcset-input');
    s.dataset.prop = '$memory';
    for (const m of [...new Set([...MEMORY, v.draft.memory])]) s.add(new Option(m, m));
    s.value = v.draft.memory;
    s.onchange = () => { v.draft.memory = s.value; update(v); };
    return s;
  }
  function motdControl(v) {
    const box = el('div', 'mcset-motd');
    const t = el('textarea', 'input mcset-motd-input');
    t.rows = 2;
    t.dataset.prop = 'motd';
    t.value = v.draft.props.motd;
    t.spellcheck = false;
    const preview = el('div', 'mcset-motd-preview');
    const paint = () => {
      const name = el('div', 'mcset-motd-name', v.srv.name);
      preview.replaceChildren(name, ...t.value.split('\n').slice(0, 2).map(motdLine));
    };
    t.oninput = () => {
      if (t.value.split('\n').length > 2) t.value = t.value.split('\n').slice(0, 2).join('\n');
      setProp(v, 'motd', t.value);
      paint();
    };
    paint();
    box.append(t, preview);
    return box;
  }
  // One line of the message drawn as the multiplayer list draws it: a color code resets the formats, §r resets all.
  function motdLine(text) {
    const line = el('div', 'mcset-motd-line');
    let st = { color: COLORS[7] };
    for (const part of text.split(/(§[0-9a-fk-or])/i)) {
      const code = /^§(.)$/i.exec(part)?.[1].toLowerCase();
      if (code) { st = COLORS[code] ? { color: COLORS[code] } : code === 'r' ? { color: COLORS[7] } : { ...st, [code]: true }; continue; }
      if (!part) continue;
      const span = el('span', null, part);
      span.style.color = st.color;
      if (st.l) span.style.fontWeight = '700';
      if (st.o) span.style.fontStyle = 'italic';
      span.style.textDecoration = [st.n && 'underline', st.m && 'line-through'].filter(Boolean).join(' ') || 'none';
      line.append(span);
    }
    if (!line.childNodes.length) line.append(' ');
    return line;
  }
  function jvmControl(v) {
    const box = el('div', 'mcset-jvm');
    const area = el('textarea', 'input mcset-jvm-input');
    area.rows = 6;
    area.spellcheck = false;
    area.dataset.prop = '$jvm';
    const show = () => {
      area.value = (v.draft.jvmArgs ?? v.base.defaultJvmArgs).join('\n');
      area.disabled = v.draft.jvmArgs === null;
    };
    const rec = toggle(v.draft.jvmArgs === null, (on) => {
      v.draft.jvmArgs = on ? null : [...v.base.defaultJvmArgs];
      v.invalid.delete('$jvm');
      area.classList.remove('invalid');
      show();
      update(v);
    });
    rec.classList.add('mcset-jvm-default');
    rec.querySelector('input').dataset.prop = '$jvmDefault';
    const head = el('label', 'mcset-jvm-head');
    head.append(rec, el('span', null, tr('The recommended options (Aikar\'s flags for a server, Velocity\'s for a proxy)')));
    area.oninput = () => {
      const args = area.value.split(/\s+/).filter(Boolean);
      const bad = args.find((a) => !a.startsWith('-') || /^-Xmx/i.test(a));
      area.classList.toggle('invalid', !!bad);
      area.title = bad ? (/^-Xmx/i.test(bad) ? tr('Set the memory above instead of -Xmx') : tr('{option} does not start with -', { option: bad })) : '';
      if (bad) v.invalid.add('$jvm'); else v.invalid.delete('$jvm');
      v.draft.jvmArgs = args;
      update(v);
    };
    show();
    box.append(head, area, el('div', 'mcset-desc muted', tr('One option a line, given to Java before the server. The memory is set above.')));
    return box;
  }

  // ---------- players ----------
  // An online-mode server (or one behind a proxy, which forwards the players' real accounts) knows players by their
  // Mojang account; an offline one by the UUID their name gives.
  const realAccounts = (v) => v.draft.props['online-mode'] !== 'false' || mc.servers().some((s) => s.proxy);
  function playerList(v, which) {
    const box = el('div', 'mcset-players');
    box.dataset.list = which;
    const list = el('div', 'mcset-plist');
    const add = el('form', 'mcset-padd');
    const name = el('input', 'input mcset-pname');
    name.placeholder = tr('Player name');
    name.spellcheck = false;
    const go = el('button', 'secondary', tr('Add'));
    go.type = 'submit';
    const error = el('div', 'mcset-perror');
    add.append(name, go);
    const paint = () => {
      const running = mc.runningAt(v.srv.dir);
      list.replaceChildren();
      if (!v.draft[which].length) list.append(el('div', 'mcset-pempty muted', which === 'ops' ? tr('No operators yet.') : tr('No players on the whitelist yet.')));
      for (const p of v.draft[which]) {
        const r = el('div', 'mcset-player');
        r.append(el('span', 'mcset-pface', p.name.slice(0, 1).toUpperCase()), el('span', 'mcset-pn', p.name), el('span', 'mcset-puuid muted', p.uuid));
        if (which === 'ops') {
          const lv = el('select', 'input mcset-plevel');
          for (let i = 1; i <= 4; i++) lv.add(new Option(tr('Level {level}', { level: i }), String(i)));
          lv.value = String(p.level || 4);
          lv.disabled = running;
          lv.title = running ? tr('Stop the server to change a level: a running server keeps its own list') : CHOICES()['op-permission-level'][lv.value];
          lv.onchange = () => { p.level = Number(lv.value); update(v); };
          r.append(lv);
        }
        const x = el('button', 'secondary mcset-premove', '✕');
        x.title = tr('Remove {name}', { name: p.name });
        x.onclick = () => { v.draft[which] = v.draft[which].filter((q) => q !== p); paint(); update(v); };
        r.append(x);
        list.append(r);
      }
    };
    add.onsubmit = async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) return;
      if (v.draft[which].some((p) => p.name.toLowerCase() === n.toLowerCase())) { error.textContent = tr('{name} is on the list already.', { name: n }); return; }
      go.disabled = true;
      error.textContent = '';
      try {
        const p = await ide.api.invoke('minecraft:player', n, realAccounts(v));
        v.draft[which] = [...v.draft[which], which === 'ops' ? { ...p, level: Number(v.draft.props['op-permission-level']) || 4, bypassesPlayerLimit: false } : p];
        name.value = '';
        paint();
        update(v);
      } catch (err) {
        error.textContent = /noAccount|No Minecraft account/.test(mc.errorText(err)) ? tr('No Minecraft account is named {name}.', { name: n }) : mc.errorText(err);
      } finally { go.disabled = false; }
    };
    paint();
    box.append(list, add, error);
    return box;
  }
  // What a running server is told for the list changes: it writes its own files.
  function listCommands(which, before, after) {
    const had = new Set(before.map((p) => p.name.toLowerCase()));
    const has = new Set(after.map((p) => p.name.toLowerCase()));
    const [add, remove] = which === 'ops' ? ['op', 'deop'] : ['whitelist add', 'whitelist remove'];
    return [...after.filter((p) => !had.has(p.name.toLowerCase())).map((p) => `${add} ${p.name}`),
      ...before.filter((p) => !has.has(p.name.toLowerCase())).map((p) => `${remove} ${p.name}`)];
  }

  // ---------- mods, other ----------
  function translation(v) {
    const box = el('div', 'mc-translate');
    const status = el('div', 'mc-translate-status muted', tr('Looking for text without Korean…'));
    const go = el('button', 'secondary mc-translate-run', tr('Translate to Korean'));
    go.title = tr('Claude translates the mods\' text that has no Korean yet into the server\'s resource pack');
    go.disabled = true;
    const count = () => ide.api.invoke('minecraft:langStatus', ide.root, v.srv.dir).then((st) => {
      const todo = st.mods.filter((m) => m.missing);
      status.textContent = !st.mods.length ? tr('No mod in mods/ has English text to translate.')
        : !st.missing ? tr('Every line of the {count} mods has Korean.', { count: st.mods.length })
          : tr('{lines} lines in {mods} of the {count} mods have no Korean yet.', { lines: st.missing, mods: todo.length, count: st.mods.length });
      status.title = todo.map((m) => `${m.jar}: ${m.missing}/${m.total}`).join('\n');
      go.disabled = !st.missing;
    }, (err) => { status.textContent = mc.errorText(err); });
    go.onclick = async () => {
      go.disabled = true;
      await mc.translateKorean(mc.servers().find((s) => s.dir === v.srv.dir) || v.srv);
      count();
    };
    count();
    box.append(status, go, el('div', 'mcset-desc muted', tr('Claude (your Claude Code) writes the lines into the resource pack, resourcepack/assets/<mod>/lang/ko_kr.json, and Send to Players gives them to everyone. Lines already there, and your edits, are kept.')));
    return box;
  }
  function otherRows(v) {
    const keys = Object.keys(v.draft.props).filter((k) => !v.schema.has(k)).sort();
    if (!keys.length) return [el('div', 'mcset-note', tr('server.properties has no other lines.'))];
    return keys.map((k) => {
      const i = el('input', 'input mcset-input mcset-other');
      i.dataset.prop = k;
      i.value = v.draft.props[k];
      i.spellcheck = false;
      i.oninput = () => setProp(v, k, i.value);
      const r = row(v, k, k, '', i);
      r.classList.add('mcset-mono');
      return r;
    });
  }

  // ---------- save ----------
  async function commit(v) {
    const c = changes(v);
    const running = mc.runningAt(v.srv.dir);
    const payload = {};
    if (Object.keys(c.props).length) payload.props = c.props;
    if (c.memory) payload.memory = v.draft.memory;
    if (c.jvm) payload.jvmArgs = v.draft.jvmArgs;
    const commands = [];
    for (const which of ['whitelist', 'ops']) {
      if (!c[which]) continue;
      if (running) commands.push(...listCommands(which, v.base[which], v.draft[which]));
      else payload[which] = v.draft[which];
    }
    v.save.disabled = true;
    let fresh = null;
    try {
      if (Object.keys(payload).length) fresh = await ide.api.invoke('minecraft:saveSettings', ide.root, v.srv.dir, payload);
    } catch (err) {
      v.status.textContent = mc.errorText(err);
      v.status.classList.add('mcset-error');
      v.save.disabled = false;
      return;
    }
    for (const line of commands) mc.sendCommand(v.srv.dir, line);
    const scrollTop = v.scroll.scrollTop;
    const lists = { whitelist: v.draft.whitelist, ops: v.draft.ops };
    if (fresh) {
      v.base = fresh;
      for (const p of fresh.schema) v.base.props[p.key] ??= p.def;
    }
    // The running server writes the lists itself once it has run the commands.
    if (commands.length) Object.assign(v.base, clone(lists));
    reset(v);
    render(v);
    v.scroll.scrollTop = scrollTop;
    v.status.textContent = commands.length && !fresh ? tr('Sent to the server\'s console.') : tr('Saved.');
    await mc.refresh();
    if (fresh && running) {
      ide.notifications?.notify({ title: tr('Settings of {name} saved', { name: v.srv.name }), text: tr('They apply when the server starts again.'), group: 'Minecraft',
        actions: [{ label: tr('Restart'), run: (n) => { n.expire(); mc.restartIfRunning(v.srv.dir, mc.jobSession(tr('Server Settings'))); } }] });
    }
  }

  mc.settings = { open, tabId, paintStates };
})();
