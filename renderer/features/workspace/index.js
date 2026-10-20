// My Workspace: the Launchers tool window (every way this project is started, each with its own console),
// port checks before a server starts, "Open in Browser" for local URLs a process prints, and the Workspace
// home tab (project, branch, venvs, launchers, README, recent projects).
(() => {
  const { el, basename, dirname, samePath, isUnder } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`workspace:${ch}`, ...args);
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const button = (cls, text, title, onclick) => {
    const b = el('button', cls, text);
    if (title) b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onclick(e); };
    return b;
  };
  const HOME_ID = 'workspace:home';
  const MAX_RECENT = 10;

  const KINDS = [
    { kind: 'launch', icon: '🚀', title: tr('Launch Configurations') },
    { kind: 'pycharm', icon: '◆', title: tr('PyCharm Run Configurations') },
    { kind: 'module', icon: '📦', title: tr('Python Modules') },
    { kind: 'script', icon: '🐍', title: tr('Python Scripts') },
    { kind: 'bat', icon: '▤', title: tr('Batch Scripts') },
    { kind: 'ps1', icon: '⚡', title: tr('PowerShell Scripts') },
    { kind: 'maven', icon: '☕', title: tr('Maven Goals') },
    { kind: 'gradle', icon: '🐘', title: tr('Gradle Tasks') },
  ];
  const kindOf = (k) => KINDS.find((x) => x.kind === k) || { icon: '▶', title: k };

  // ---------- state ----------
  let scanned = { entries: [], venvs: [] };
  let info = { branch: null, readme: null };
  let scanning = false;
  let selectedId = null;
  const runs = new Map(); // `${root}|${entry.id}` -> run state (consoles survive switching projects)
  const collapsed = new Set(ide.settings.get('workspace.collapsed', []));

  const entries = () => scanned.entries;
  const findEntry = (id) => entries().find((e) => e.id === id) || null;
  const runKey = (entry) => `${ide.root}|${entry.id}`;
  const runOf = (entry) => runs.get(runKey(entry)) || null;
  const busy = (r) => !!r && (r.running || r.starting);

  const argsKey = () => `workspace.args:${ide.root}`;
  const argsFor = (entry) => {
    const saved = ide.settings.get(argsKey(), {});
    return entry.id in saved ? saved[entry.id] : entry.defaultArgs || '';
  };
  function saveArgs(entry, value) {
    const saved = { ...ide.settings.get(argsKey(), {}) };
    saved[entry.id] = value;
    ide.settings.set(argsKey(), saved);
  }

  // Python launchers run with the project's interpreter, or with a venv that sits next to them (ai\.venv for ai\train.py).
  function interpFor(entry) {
    const near = scanned.venvs
      .filter((v) => v.python && !samePath(dirname(v.path), ide.root) && isUnder(entry.file, dirname(v.path)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (near) return { cmd: near.python, args: [], label: `${near.rel}${near.version ? ` (Python ${near.version})` : ''}` };
    const it = ide.currentInterp();
    return it ? { cmd: it.cmd, args: it.args, label: it.label } : null;
  }

  function subtitle(e) {
    switch (e.kind) {
      case 'launch': return [ide.util.rel(e.exe), ...e.runtimeArgs].join(' ');
      case 'pycharm': return [e.module ? `-m ${e.module}` : ide.util.rel(e.script), e.defaultArgs].filter(Boolean).join(' ');
      case 'module': return ide.util.rel(dirname(e.file));
      case 'script': return e.flags?.length ? e.flags.join(' ') : ide.util.rel(e.file);
      default: return ide.util.rel(e.file);
    }
  }

  // ---------- local URLs printed by a running process ----------
  const URL_RE = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{1,5})?(\/[^\s'"<>)\]]*)?/gi;
  function urlsIn(line) {
    const out = [];
    for (const m of line.matchAll(URL_RE)) {
      const host = /^(0\.0\.0\.0|\[::\])$/.test(m[1]) ? 'localhost' : m[1].toLowerCase();
      out.push(`${m[0].slice(0, m[0].indexOf(':')).toLowerCase()}://${host}${m[2] || ''}${(m[3] || '/').replace(/[.,;:]+$/, '')}`);
    }
    // Jetty (mvn jetty:run) and Spring Boot announce a port, not a URL.
    const j = line.match(/ServerConnector@\w+\{HTTP[^}]*\}\{[^}]*:(\d{2,5})\}/) || line.match(/Tomcat (?:started|initialized) on port(?:\(s\))?:? (\d{2,5})/);
    if (j) out.push(`http://localhost:${j[1]}/`);
    return out;
  }
  function addUrl(r, url) {
    if (r.urls.includes(url)) return;
    r.urls.push(url);
    renderRunViews(r.entry);
  }
  function scanOutput(r, text) {
    const lines = (r.lineBuf + text).split(/\r?\n/);
    r.lineBuf = lines.pop().slice(-500);
    for (const line of lines) for (const u of urlsIn(line)) addUrl(r, u);
  }
  const openUrl = (url) => invoke('openUrl', url).catch((err) => ide.ui.dialog({ title: tr('Open in Browser'), body: el('div', null, err.message) }));

  // ---------- running ----------
  function ensureRun(entry) {
    let r = runOf(entry);
    if (r) { r.entry = entry; return r; }
    const host = el('div', 'ws-console hidden');
    host.dataset.id = entry.id;
    r = { entry, root: ide.root, host, con: null, procId: null, running: false, starting: false, status: 'idle', urls: [], lineBuf: '', port: null, exitWaiters: [] };
    r.con = ide.ui.console(host, {
      input: true,
      placeholder: tr('stdin: type input and press Enter'),
      onInput(text) {
        if (!r.running) return;
        r.con.append(`${text}\n`, 'cmd');
        ide.proc.input(r.procId, `${text}\n`);
      },
    });
    r.con.input.disabled = true;
    runs.set(runKey(entry), r);
    consoles?.appendChild(host);
    return r;
  }

  // Resolves to 'stop', 'anyway' or 'cancel'.
  function askPortInUse(entry, pc, holder) {
    return new Promise((resolve) => {
      let choice = 'cancel';
      const body = el('div', 'ws-port-dialog');
      body.dataset.port = pc.port;
      body.dataset.pid = pc.pid || '';
      const who = holder
        ? tr("Port {port} is already in use by the launcher '{name}'.", { port: pc.port, name: holder.entry.name })
        : pc.pid
          ? tr('Port {port} is already in use by {process} (PID {pid}).', { port: pc.port, process: pc.name || tr('an unknown process'), pid: pc.pid })
          : tr('Port {port} is already in use by another process.', { port: pc.port });
      body.append(el('p', null, who), el('p', 'muted', tr("Starting '{name}' now will probably fail to bind the port.", { name: entry.name })));
      const canStop = holder || pc.pid;
      ide.ui.dialog({
        title: tr('Port {port} Is in Use', { port: pc.port }),
        body,
        width: 500,
        onClose: () => resolve(choice),
        buttons: [
          ...(canStop ? [{ label: tr('Stop That Process'), primary: true, run: () => { choice = 'stop'; } }] : []),
          { label: tr('Run Anyway'), primary: !canStop, run: () => { choice = 'anyway'; } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  const confirm = ({ title, text, ok }) => new Promise((resolve) => {
    let yes = false;
    const body = el('div', 'ws-confirm');
    body.append(el('p', null, text));
    ide.ui.dialog({ title, body, width: 460, onClose: () => resolve(yes), buttons: [{ label: ok, primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }] });
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitPortFree(port, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await invoke('portInUse', port))) return true;
      await sleep(250);
    }
    return false;
  }

  // Stops whatever holds the port (one of our launchers, or any process after confirmation).
  async function stopHolder(r, pc, holder) {
    if (holder) {
      await stopRun(holder);
    } else {
      const ok = await confirm({
        title: tr('Stop Process'),
        text: tr('Terminate {process} (PID {pid})? Anything unsaved in that process will be lost.', { process: pc.name || tr('an unknown process'), pid: pc.pid }),
        ok: tr('Terminate'),
      });
      if (!ok) return false;
      const res = await invoke('killPid', pc.pid);
      if (!res.ok) {
        r.con.append(`${tr('Could not stop process {pid}: {error}', { pid: pc.pid, error: res.error })}\n`, 'err');
        return false;
      }
      r.con.append(`${tr('Stopped {process} (PID {pid}).', { process: pc.name || pc.pid, pid: pc.pid })}\n`, 'sys');
    }
    if (!(await waitPortFree(pc.port))) {
      r.con.append(`${tr('Port {port} is still in use.', { port: pc.port })}\n`, 'err');
      return false;
    }
    return true;
  }

  function stopRun(r) {
    if (!r?.running) return Promise.resolve();
    return new Promise((resolve) => { r.exitWaiters.push(resolve); ide.proc.kill(r.procId); });
  }

  async function runEntry(entry, { show = true } = {}) {
    if (!ide.root) return;
    const r = ensureRun(entry);
    select(entry);
    if (show) tw.show();
    if (r.starting) return;
    if (r.running) await stopRun(r);
    const before = r.status;
    r.starting = true;
    r.status = 'starting';
    renderRunViews(entry);
    try {
      const args = argsFor(entry);
      const pc = await invoke('checkPort', ide.root, entry, args);
      r.port = pc.port;
      if (pc.inUse) {
        const holder = [...runs.values()].find((o) => o !== r && o.running && o.port === pc.port) || null;
        const choice = await askPortInUse(entry, pc, holder);
        if (choice === 'cancel') { r.status = before; return; }
        if (choice === 'stop' && !(await stopHolder(r, pc, holder))) { r.status = before; return; }
        if (choice === 'anyway') r.con.append(`${tr('Port {port} is in use; running anyway.', { port: pc.port })}\n`, 'sys');
      }
      const interp = entry.python ? interpFor(entry) : null;
      if (entry.python && entry.kind !== 'launch' && !interp) {
        r.con.append(`${tr('No Python interpreter found.')}\n`, 'err');
        r.status = 'failed';
        return;
      }
      await ide.saveAll();
      const { id, command } = await invoke('start', ide.root, entry, args, interp && { cmd: interp.cmd, args: interp.args });
      r.con.append(`${command}\n`, 'sys');
      attach(r, id);
    } catch (err) {
      r.con.append(`${err.message}\n`, 'err');
      r.status = 'failed';
    } finally {
      r.starting = false;
      renderRunViews(entry);
    }
  }

  function attach(r, id) {
    r.procId = id;
    r.running = true;
    r.status = 'running';
    r.urls = [];
    r.lineBuf = '';
    r.exitCode = null;
    r.con.input.disabled = false;
    ide.proc.attach(id, {
      data(text, stream) {
        r.con.append(text, stream === 'err' ? 'err' : null);
        scanOutput(r, text);
      },
      exit(code) {
        if (r.procId !== id) return;
        scanOutput(r, '\n');
        r.con.append(`\n${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n`, 'sys');
        r.running = false;
        r.exitCode = code ?? 1;
        r.status = code === 0 ? 'done' : 'failed';
        r.urls = [];
        r.con.input.disabled = true;
        for (const w of r.exitWaiters.splice(0)) w();
        renderRunViews(r.entry);
      },
    });
    watchLaunchUrl(r, id);
  }

  // A launch.json "url" is offered once its port starts accepting connections.
  async function watchLaunchUrl(r, id) {
    const url = r.entry.kind === 'launch' && r.entry.url;
    if (!url || !r.port || !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(url)) return;
    for (let i = 0; i < 120 && r.running && r.procId === id; i++) {
      await sleep(1000);
      if (r.running && r.procId === id && (await invoke('portInUse', r.port))) { addUrl(r, url); return; }
    }
  }

  const toggleRun = (entry) => (busy(runOf(entry)) ? stopRun(runOf(entry)) : runEntry(entry));

  // ---------- Launchers tool window ----------
  let list;
  let detail;
  let consoles;
  const tw = ide.registerToolWindow({
    id: 'Launchers', title: tr('Launchers'), icon: '🚀', side: 'left', keys: 'Alt+Shift+L', order: 30,
    mount(container) {
      container.id = 'wsTool';
      container.classList.add('ws-tool');
      list = el('div', 'ws-list');
      list.id = 'wsList';
      const split = el('div', 'ws-hsplit');
      detail = el('div', 'ws-detail');
      detail.id = 'wsDetail';
      consoles = el('div', 'ws-consoles');
      container.append(list, split, detail);
      split.onmousedown = (down) => {
        const start = down.clientY;
        const h = list.offsetHeight;
        const move = (e) => { list.style.flex = `0 0 ${Math.max(60, Math.min(container.offsetHeight - 120, h + e.clientY - start))}px`; };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      };
    },
  });
  tw.setActions([
    { icon: '⟳', title: tr('Refresh Launchers'), run: () => refresh() },
    { icon: '⌂', title: tr('Workspace Home'), run: () => openHome() },
  ]);

  function statusIcon(r) {
    const s = el('span', `ws-state ${r?.status || 'idle'}`);
    s.title = r?.running ? tr('Running') : '';
    return s;
  }

  function entryRow(e, cls = 'ws-row') {
    const r = runOf(e);
    const row = el('div', `${cls}${e.id === selectedId ? ' selected' : ''}${busy(r) ? ' running' : ''}`);
    row.dataset.id = e.id;
    row.dataset.kind = e.kind;
    const icon = el('span', 'ws-icon', kindOf(e.kind).icon);
    icon.title = kindOf(e.kind).title;
    const text = el('div', 'ws-text');
    text.append(userText('span', 'ws-name', e.name), userText('span', 'ws-sub', subtitle(e)));
    row.append(statusIcon(r), icon, text);
    const port = r?.port || e.port;
    if (port) {
      const p = el('span', 'ws-port', `:${port}`);
      p.title = tr('Port {port}', { port });
      row.appendChild(p);
    }
    if (r?.urls.length) {
      const a = button('ws-open', '🌐', tr('Open in Browser'), () => openUrl(r.urls[0]));
      a.dataset.url = r.urls[0];
      row.appendChild(a);
    }
    const run = button(`ws-run${busy(r) ? ' stop' : ''}`, busy(r) ? '■' : '▶', busy(r) ? tr('Stop') : tr('Run'), () => toggleRun(e));
    row.appendChild(run);
    return row;
  }

  function renderList() {
    if (!list) return;
    list.replaceChildren();
    if (!ide.root) return list.appendChild(el('div', 'ws-empty muted', tr('Open a project to see its launchers.')));
    if (scanning && !entries().length) return list.appendChild(el('div', 'ws-empty muted', tr('Scanning…')));
    if (!entries().length) {
      list.append(el('div', 'ws-empty muted', tr('No launchers found in this project.')),
        el('div', 'ws-empty-hint muted', tr('Launchers come from .claude/launch.json, run/start scripts, python -m packages, scripts with a __main__ block, PyCharm run configurations, Maven and Gradle builds.')));
      return;
    }
    for (const k of KINDS) {
      const group = entries().filter((e) => e.kind === k.kind);
      if (!group.length) continue;
      const closed = collapsed.has(k.kind);
      const head = el('div', `ws-group${closed ? ' closed' : ''}`);
      head.dataset.kind = k.kind;
      head.append(el('span', 'ws-arrow', closed ? '▸' : '▾'), el('span', 'ws-icon', k.icon), el('span', 'ws-group-title', k.title), el('span', 'ws-count', String(group.length)));
      head.onclick = () => {
        closed ? collapsed.delete(k.kind) : collapsed.add(k.kind);
        ide.settings.set('workspace.collapsed', [...collapsed]);
        renderList();
      };
      list.appendChild(head);
      if (closed) continue;
      for (const e of group) {
        const row = entryRow(e);
        row.onclick = () => select(e);
        row.ondblclick = () => runEntry(e);
        row.oncontextmenu = (ev) => {
          ev.preventDefault();
          select(e);
          const r = runOf(e);
          ide.ui.contextMenu(ev.clientX, ev.clientY, [
            { label: busy(r) ? tr('Rerun') : tr('Run'), run: () => runEntry(e) },
            { label: tr('Stop'), disabled: !busy(r), run: () => stopRun(r) },
            ...(r?.urls.length ? [{ label: tr('Open in Browser'), run: () => openUrl(r.urls[0]) }] : []),
            { separator: true },
            { label: tr('Open File'), disabled: e.kind === 'pycharm' && !!e.module, run: () => ide.openFile(e.script || e.file) },
          ]);
        };
        list.appendChild(row);
      }
    }
  }

  function select(entry) {
    selectedId = entry?.id || null;
    for (const row of list?.querySelectorAll('.ws-row') || []) row.classList.toggle('selected', row.dataset.id === selectedId);
    renderDetail();
  }

  function renderDetail() {
    if (!detail) return;
    const e = selectedId && findEntry(selectedId);
    for (const r of runs.values()) r.host.classList.toggle('hidden', !e || r !== runOf(e));
    consoles.classList.toggle('hidden', !e);
    if (!e) {
      detail.replaceChildren(el('div', 'ws-empty muted', tr('Select a launcher to see its output.')), consoles);
      return;
    }
    const r = ensureRun(e);
    r.host.classList.remove('hidden');
    const head = el('div', 'ws-detail-head');
    head.append(statusIcon(r), el('span', 'ws-icon', kindOf(e.kind).icon), userText('span', 'ws-detail-name', e.name), el('span', 'spacer'));
    // Local URLs the process printed, each with "Open in Browser".
    const urls = el('div', 'ws-urls');
    for (const url of r.urls) {
      const row = el('div', 'ws-url-row');
      const link = el('a', 'ws-link', tr('Open in Browser'));
      link.href = '#';
      link.dataset.url = url;
      link.onclick = (ev) => { ev.preventDefault(); openUrl(url); };
      row.append(el('span', 'ws-icon', '🌐'), link, userText('span', 'ws-url', url));
      urls.appendChild(row);
    }
    head.append(
      button('ws-tool-btn ws-detail-run', busy(r) ? '⟳' : '▶', busy(r) ? tr('Rerun') : tr('Run'), () => runEntry(e)),
      button('ws-tool-btn ws-detail-stop', '■', tr('Stop'), () => stopRun(r)),
      button('ws-tool-btn', '⌫', tr('Clear All'), () => r.con.clear()),
    );
    head.querySelector('.ws-detail-stop').disabled = !busy(r);

    const argsRow = el('label', 'ws-field');
    const input = el('input', 'ws-args');
    input.id = 'wsArgs';
    input.value = argsFor(e);
    input.placeholder = e.kind === 'launch' ? tr('Appended to runtimeArgs') : tr('Extra command-line arguments');
    input.spellcheck = false;
    input.oninput = () => saveArgs(e, input.value);
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); runEntry(e); } };
    argsRow.append(el('span', null, tr('Arguments:')), input);

    const meta = el('div', 'ws-meta');
    const metaRow = (label, value) => {
      const m = el('div', 'ws-meta-row');
      m.append(el('span', 'muted', label), userText('span', 'ws-meta-value', value));
      meta.appendChild(m);
    };
    metaRow(tr('Working directory:'), e.cwdRel === '.' ? basename(ide.root) : e.cwdRel);
    if (e.python) metaRow(tr('Interpreter:'), interpFor(e)?.label || tr('none'));
    if (e.source) metaRow(tr('Defined in:'), e.source);
    if (e.flags?.length) {
      const m = el('div', 'ws-meta-row ws-flags');
      m.appendChild(el('span', 'muted', tr('argparse options:')));
      for (const f of e.flags) {
        const chip = userText('button', 'ws-chip', f);
        chip.title = tr('Add to arguments');
        chip.onclick = () => {
          if (f.startsWith('<')) return;
          input.value = `${input.value.trim()} ${f}`.trim();
          saveArgs(e, input.value);
          input.focus();
        };
        m.appendChild(chip);
      }
      meta.appendChild(m);
    }
    detail.replaceChildren(head, urls, argsRow, meta, consoles);
  }

  // Rows and the detail header reflect a run's state in both the tool window and the home tab.
  function renderRunViews(entry) {
    if (list) {
      const old = list.querySelector(`.ws-row[data-id="${CSS.escape(entry.id)}"]`);
      if (old) {
        const row = entryRow(entry);
        row.onclick = old.onclick;
        row.ondblclick = old.ondblclick;
        row.oncontextmenu = old.oncontextmenu;
        old.replaceWith(row);
      }
    }
    if (selectedId === entry.id) {
      const input = detail?.querySelector('#wsArgs');
      const focused = document.activeElement === input;
      const caret = input?.selectionStart;
      renderDetail();
      if (focused) { const i = detail.querySelector('#wsArgs'); i.focus(); i.setSelectionRange(caret, caret); }
    }
    renderHomeLaunchers();
  }

  // ---------- scanning ----------
  let refreshSeq = 0;
  async function refresh() {
    const root = ide.root;
    if (!root) return;
    const seq = ++refreshSeq;
    scanning = true;
    renderList();
    try {
      const [s, i] = await Promise.all([invoke('scan', root), invoke('info', root)]);
      if (seq !== refreshSeq || root !== ide.root) return;
      scanned = s;
      info = i;
    } catch (err) {
      console.error('workspace scan failed', err);
    } finally {
      if (seq === refreshSeq) scanning = false;
    }
    if (selectedId && !findEntry(selectedId)) selectedId = null;
    renderList();
    renderDetail();
    renderHome();
  }

  // ---------- Workspace home tab ----------
  let homeHost = null;
  let homeLaunchers = null;
  let closedHomeLast = false;

  const initials = (name) => {
    const words = name.split(/[\s_.-]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  };
  const hue = (s) => [...s.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;
  function avatar(name, cls = 'ws-avatar') {
    const a = userText('span', `${cls} ws-av${hue(name)}`, initials(name));
    a.setAttribute('aria-hidden', 'true');
    return a;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(d)) / 86400000);
    if (diff === 0) return tr('Today');
    if (diff === 1) return tr('Yesterday');
    return d.toLocaleDateString(i18n.locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const recent = () => ide.settings.get('workspace.recent', []);
  function remember(root) {
    const list = recent().filter((p) => !samePath(p.path, root));
    list.unshift({ path: root, name: basename(root), opened: new Date().toISOString() });
    ide.settings.set('workspace.recent', list.slice(0, MAX_RECENT));
  }
  function forget(path) {
    ide.settings.set('workspace.recent', recent().filter((p) => !samePath(p.path, path)));
    renderHome();
  }

  async function openRecent(p) {
    if (samePath(p.path, ide.root)) return;
    if (!(await ide.api.exists(p.path))) {
      const yes = await confirm({ title: tr('Recent Projects'), text: tr('The folder {path} no longer exists. Remove it from Recent Projects?', { path: p.path }), ok: tr('Remove') });
      if (yes) forget(p.path);
      return;
    }
    await ide.openProject(p.path);
  }

  function card(title, cls, actions = []) {
    const c = el('section', `ws-card ${cls}`);
    const head = el('div', 'ws-card-head');
    head.append(el('h3', null, title), el('span', 'spacer'), ...actions);
    c.appendChild(head);
    return c;
  }

  function renderRecent(side) {
    side.replaceChildren(el('div', 'ws-side-title', tr('Recent Projects')));
    const items = recent();
    const box = el('div', 'ws-recent-list');
    if (!items.length) box.appendChild(el('div', 'muted ws-none', tr('No recent projects.')));
    for (const p of items) {
      const row = el('div', `ws-recent${samePath(p.path, ide.root) ? ' current' : ''}`);
      row.dataset.path = p.path;
      row.title = p.path;
      const text = el('div', 'ws-text');
      text.append(userText('span', 'ws-name', p.name || basename(p.path)), userText('span', 'ws-sub', p.path));
      const when = el('span', 'ws-when', fmtDate(p.opened));
      const x = button('ws-forget', '×', tr('Remove from Recent Projects'), () => forget(p.path));
      row.append(avatar(p.name || basename(p.path), 'ws-avatar sm'), text, when, x);
      row.onclick = () => openRecent(p);
      box.appendChild(row);
      ide.api.exists(p.path).then((ok) => row.classList.toggle('missing', !ok));
    }
    const open = button('secondary ws-open-folder', tr('Open Folder…'), '', () => ide.runAction('OpenProject'));
    side.append(box, open);
  }

  function renderHomeLaunchers() {
    if (!homeLaunchers) return;
    const c = homeLaunchers;
    c.querySelector('.ws-card-body')?.remove();
    const body = el('div', 'ws-card-body');
    const all = entries();
    if (!all.length) {
      body.appendChild(el('div', 'muted ws-none', scanning ? tr('Scanning…') : tr('No launchers found in this project.')));
    } else {
      const pills = el('div', 'ws-pills');
      for (const k of KINDS) {
        const n = all.filter((e) => e.kind === k.kind).length;
        if (!n) continue;
        const pill = el('span', 'ws-pill');
        pill.dataset.kind = k.kind;
        pill.append(el('span', null, k.icon), el('span', null, k.title), el('b', null, String(n)));
        pills.appendChild(pill);
      }
      body.appendChild(pills);
      const quick = el('div', 'ws-quick');
      for (const e of all.slice(0, 8)) {
        const row = entryRow(e, 'ws-row ws-quick-row');
        row.classList.remove('selected');
        row.onclick = () => { select(e); tw.show(); };
        quick.appendChild(row);
      }
      body.appendChild(quick);
      if (all.length > 8) body.appendChild(el('div', 'muted ws-more', tr('{count} more in the Launchers tool window', { count: all.length - 8 })));
    }
    c.appendChild(body);
  }

  function renderHome() {
    if (!homeHost) return;
    const page = el('div', 'ws-home');
    page.id = 'wsHome';
    const side = el('aside', 'ws-home-side');
    renderRecent(side);
    const main = el('div', 'ws-home-main');
    page.append(side, main);

    if (!ide.root) {
      main.appendChild(el('div', 'muted ws-none', tr('Open a project to see its launchers.')));
      homeHost.replaceChildren(page);
      homeLaunchers = null;
      return;
    }
    const name = basename(ide.root);
    const hero = el('div', 'ws-hero');
    const title = el('div', 'ws-hero-text');
    title.append(userText('h1', 'ws-project-name', name), userText('div', 'ws-project-path', ide.root));
    const chips = el('div', 'ws-chips');
    const branch = el('span', `ws-chip-info ws-branch${info.branch ? '' : ' none'}`);
    branch.title = tr('Git branch');
    branch.append(el('span', null, '⑂'), info.branch ? userText('span', 'ws-branch-name', info.branch) : el('span', null, tr('No Git repository')));
    chips.appendChild(branch);
    const interp = ide.currentInterp();
    const ic = el('span', 'ws-chip-info ws-interp');
    ic.title = tr('Python interpreter');
    ic.append(el('span', null, '🐍'), interp ? userText('span', null, interp.label) : el('span', null, tr('No interpreter')));
    chips.appendChild(ic);
    title.appendChild(chips);
    hero.append(avatar(name, 'ws-avatar lg'), title, el('span', 'spacer'),
      button('ws-tool-btn ws-refresh', '⟳', tr('Refresh'), () => refresh()));
    main.appendChild(hero);

    const grid = el('div', 'ws-cards');
    homeLaunchers = card(tr('Launchers'), 'ws-card-launchers', [
      button('ws-link-btn', tr('Show All'), tr('Tool Window: {title}', { title: tr('Launchers') }), () => tw.show()),
    ]);
    grid.appendChild(homeLaunchers);
    renderHomeLaunchers();

    const venvCard = card(tr('Virtual Environments'), 'ws-card-venvs');
    const vb = el('div', 'ws-card-body');
    if (!scanned.venvs.length) vb.appendChild(el('div', 'muted ws-none', tr('No virtual environments found.')));
    const extra = ide.settings.get('interpreters.extra', []);
    for (const v of scanned.venvs) {
      const row = el('div', 'ws-venv');
      row.dataset.path = v.path;
      const text = el('div', 'ws-text');
      text.append(userText('span', 'ws-name', v.rel), el('span', 'ws-sub', v.version ? `Python ${v.version}` : tr('Unknown Python version')));
      row.append(el('span', 'ws-icon', '🐍'), text);
      const isCurrent = v.python && samePath(ide.currentInterp()?.executable, v.python);
      if (isCurrent) row.appendChild(el('span', 'ws-badge', tr('Current')));
      else if (v.python && !ide.interps.some((i) => samePath(i.executable, v.python)) && !extra.some((p) => samePath(p, v.python))) {
        row.appendChild(button('ws-link-btn', tr('Add as Interpreter'), '', async () => {
          ide.settings.set('interpreters.extra', [...ide.settings.get('interpreters.extra', []), v.python]);
          await ide.reloadInterpreters();
          renderHome();
        }));
      }
      vb.appendChild(row);
    }
    venvCard.appendChild(vb);
    grid.appendChild(venvCard);

    const rm = info.readme;
    const readmeCard = card('README', 'ws-card-readme', rm ? [button('ws-link-btn', tr('Open'), rm.name, () => ide.openFile(rm.file))] : []);
    const rb = el('div', 'ws-card-body');
    if (!rm) rb.appendChild(el('div', 'muted ws-none', tr('No README in this project.')));
    else {
      rb.appendChild(userText('div', 'ws-readme-title', rm.title || rm.name));
      if (rm.summary) rb.appendChild(userText('p', 'ws-readme-summary', rm.summary));
    }
    readmeCard.appendChild(rb);
    grid.appendChild(readmeCard);

    main.appendChild(grid);
    homeHost.replaceChildren(page);
  }

  function openHome() {
    ide.openCustomTab({
      id: HOME_ID,
      title: tr('Workspace'),
      icon: '⌂',
      mount(host) {
        homeHost = host;
        host.classList.add('ws-home-tab');
        renderHome();
      },
      onClose() { homeHost = null; homeLaunchers = null; },
    });
  }

  const homeBtn = el('button', 'tb-icon ws-home-btn', '⌂');
  homeBtn.title = tr('Workspace Home');
  homeBtn.onclick = openHome;
  ide.registerToolbarItem({ side: 'left', order: 20, el: homeBtn });
  ide.registerAction({ id: 'WorkspaceHome', title: tr('Workspace Home'), run: openHome });
  ide.registerAction({ id: 'WorkspaceRefreshLaunchers', title: tr('Refresh Launchers'), run: () => refresh() });

  // ---------- events ----------
  ide.on('projectOpened', (root) => {
    remember(root);
    scanned = { entries: [], venvs: [] };
    info = { branch: null, readme: null };
    selectedId = null;
    closedHomeLast = false;
    renderList();
    renderDetail();
    openHome();
    renderHome();
    refresh();
  });
  // Back on the welcome screen the Launchers tool window no longer lists the closed project's launchers; a scan
  // still running for it is dropped (refresh() checks the sequence).
  ide.on('projectClosed', () => {
    refreshSeq++;
    scanning = false;
    scanned = { entries: [], venvs: [] };
    info = { branch: null, readme: null };
    selectedId = null;
    renderList();
    renderDetail();
  });
  // With nothing open, the home tab comes back (unless it was the tab just closed).
  ide.on('fileClosed', (path) => { closedHomeLast = path === HOME_ID; });
  ide.on('activeTabChanged', (tab) => {
    if (tab || closedHomeLast) return;
    setTimeout(() => { if (ide.root && !ide.tabs.length && !closedHomeLast) openHome(); });
  });
  ide.on('interpreterChanged', () => { if (homeHost) renderHome(); if (selectedId) renderDetail(); });
  let fsTimer;
  ide.on('filesChanged', () => { clearTimeout(fsTimer); fsTimer = setTimeout(refresh, 1500); });

  ide.workspace = { refresh, openHome, run: runEntry, entries, runs: () => [...runs.values()].filter((r) => samePath(r.root, ide.root)) };
  renderList();
  renderDetail();
})();
