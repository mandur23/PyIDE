// Spring Boot (IntelliJ IDEA's Spring Initializr and Spring Boot run): a New Project type that makes a project with
// Spring Initializr (main/features/spring-initializr.js), runs and debugs its application class through the Maven /
// Gradle configuration of the toolchains plugin, and turns the server's port in the run output into a link. Built on
// ide.toolchains (the JDK chooser, run configurations, the dependency download).
(() => {
  const { el, basename, joinPath, isUnder } = ide.util;
  const tc = ide.toolchains;
  if (!tc) return;
  const { chooser, radios, field } = tc.ui;

  // Initializr's versions read 4.1.2, 4.2.0-M1, 4.2.0-RC1 or 4.2.0-SNAPSHOT: milestones, then release candidates, then
  // the snapshot, then the release.
  function versionKey(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[.-](M|RC|SNAPSHOT|RELEASE)(\d*))?/i.exec(String(v).trim()) || [];
    return [+m[1] || 0, +m[2] || 0, +m[3] || 0, { M: 1, RC: 2, SNAPSHOT: 3 }[(m[4] || '').toUpperCase()] ?? 4, +m[5] || 0];
  }
  function compareVersions(a, b) {
    const x = versionKey(a);
    const y = versionKey(b);
    return x.map((n, i) => n - y[i]).find((d) => d) || 0;
  }
  // A dependency's Spring Boot range: "4.0.0" (that version and later) or "[4.0.0,4.2.0-M1)".
  function inRange(range, v) {
    if (!range) return true;
    const m = /^([[(])\s*([^,]+?)\s*,\s*([^\])]*?)\s*([\])])$/.exec(range);
    if (!m) return compareVersions(v, range) >= 0;
    const lo = compareVersions(v, m[2]);
    const hi = m[3] ? compareVersions(v, m[3]) : -1;
    return (m[1] === '[' ? lo >= 0 : lo > 0) && (m[4] === ']' ? hi <= 0 : hi < 0);
  }
  const ARTIFACT = /^[A-Za-z0-9_.-]+$/;
  const SPRING_BUILDS = [['maven-project', 'Maven'], ['gradle-project', 'Gradle - Groovy'], ['gradle-project-kotlin', 'Gradle - Kotlin']];
  const SPRING_BUILD_FILE = { 'maven-project': 'pom.xml', 'gradle-project': 'build.gradle', 'gradle-project-kotlin': 'build.gradle.kts' };
  const SPRING_LAST = 'newProject.spring'; // the last project's server, language, type, group and packaging
  const springIcon = () => {
    const span = el('span', 'file-icon');
    span.dataset.type = 'spring';
    span.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path fill="#6db33f" d="M14.2 1.6c-.8 1.3-1.9 2.3-3.2 2.9A6.5 6.5 0 1 0 13.4 11c1.4-2 1.6-5.1.8-9.4ZM4.3 13.1a.6.6 0 1 1-.9-.8.6.6 0 0 1 .9.8Zm8.4-2.2c-1.6 2.2-5.1 1.4-7.3 1.5 0 0-.4 0-.8.1 0 0 .2-.1.4-.1 1.6-.6 2.4-.7 3.4-1.2 1.8-.9 3.6-2.9 4-5-.7 2-2.8 3.8-4.7 4.5-1.3.5-3.7 1-3.7 1l-.1-.1c-1.6-.8-1.6-4.3 1.2-5.4 1.2-.5 2.4-.2 3.7-.5 1.4-.3 3.1-1.4 3.8-2.9.8 2.4 1.7 6.1 0 8.1Z"/></svg>';
    return span;
  };

  // IntelliJ's Spring Boot generator in two pages. First: server URL, language, type, group, artifact, package name, JDK,
  // Java and packaging (the last project's choices come back). Next: the Spring Boot version and the dependencies, a
  // searchable tree with the added ones listed beside it and the hovered one described below.
  function springForm({ name, log }) {
    const last = ide.settings.get(SPRING_LAST, {});
    const jdk = chooser('jdk', 'npSpringJdk', tr('JDK:'));
    const input = (id, value = '') => {
      const i = el('input');
      i.id = id;
      i.value = value;
      i.spellcheck = false;
      return i;
    };
    // A row of radio buttons labelled like a field; its choices can be replaced once the server's options arrive.
    function choiceRow(label, id, list, value, onchange) {
      const row = el('div', 'field sb-choice');
      const box = el('div', 'field-row');
      box.id = id;
      row.append(el('span', null, label), box);
      const set = (items, want) => {
        const pick = items.some(([v]) => v === want) ? want : items[0]?.[0];
        box.replaceChildren(radios(id, items, pick, onchange).el);
      };
      set(list, value);
      return { row, set, value: () => box.querySelector('input:checked')?.value };
    }
    const server = input('npSpringServer', last.server || '');
    const language = choiceRow(tr('Language:'), 'npSpringLanguage', [['java', 'Java'], ['kotlin', 'Kotlin'], ['groovy', 'Groovy']], last.language || 'java');
    const build = choiceRow(tr('Type:'), 'npSpringBuild', SPRING_BUILDS, last.type || 'maven-project');
    const packaging = choiceRow(tr('Packaging:'), 'npSpringPackaging', [['jar', 'Jar'], ['war', 'War']], last.packaging || 'jar');
    const group = input('npSpringGroup', last.group || 'com.example');
    const artifact = input('npSpringArtifact');
    const pkg = input('npSpringPackage');
    const javaVersion = el('select');
    javaVersion.id = 'npSpringJava';
    const bootVersion = el('select');
    bootVersion.id = 'npSpringBoot';
    const filter = input('npSpringFilter');
    filter.classList.add('input', 'sb-filter');
    filter.placeholder = tr('Search dependencies');
    const deps = el('div', 'sb-deps');
    deps.id = 'npSpringDeps';
    const added = el('div', 'sb-added-list');
    added.id = 'npSpringAdded';
    const desc = el('div', 'sb-desc');
    desc.id = 'npSpringDesc';
    const status = el('div', 'tc-offer');
    status.id = 'npSpringStatus';

    const first = el('div', 'sb-page');
    first.id = 'npSpringPage1';
    first.append(field(tr('Server URL:'), server), language.row, build.row, field(tr('Group:'), group), field(tr('Artifact:'), artifact),
      field(tr('Package name:'), pkg), jdk.row, jdk.offer, field(tr('Java:'), javaVersion), packaging.row);
    const left = el('div', 'sb-tree');
    left.append(filter, deps);
    const right = el('div', 'sb-added');
    right.append(el('div', 'sb-added-title', tr('Added dependencies')), added);
    const split = el('div', 'sb-split');
    split.append(left, right);
    const second = el('div', 'sb-page hidden');
    second.id = 'npSpringPage2';
    second.append(field(tr('Spring Boot:'), bootVersion), el('div', 'sb-deps-title', tr('Dependencies:')), split, desc);
    const root = el('div', 'tc-np');
    root.id = 'npSpring';
    root.append(status, first, second);

    // The artifact follows the project name and the package follows both until the user types their own.
    const artifactId = () => artifact.value.trim()
      || name().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'demo';
    const packageName = () => pkg.value.trim()
      || `${group.value.trim()}.${artifactId()}`.toLowerCase().replace(/[^a-z0-9_.]/g, '').replace(/\.(\d)/g, '._$1');
    function hints() {
      if (!root.isConnected && hints.seen) return document.removeEventListener('input', hints);
      hints.seen ||= root.isConnected;
      artifact.placeholder = artifactId();
      pkg.placeholder = packageName();
    }
    document.addEventListener('input', hints);
    hints();

    let meta = null;
    const host = () => { try { return new URL(server.value.trim()).host || server.value.trim(); } catch { return server.value.trim(); } };
    const chosen = new Set(['web']);
    const collapsed = new Set();
    const allDeps = () => (meta?.dependencies || []).flatMap((g) => g.values);
    const compatible = (d) => inRange(d.versionRange, bootVersion.value);
    function describe(d) {
      if (!d) return desc.replaceChildren();
      const why = compatible(d) ? '' : tr('Needs Spring Boot {range}', { range: d.versionRange });
      desc.replaceChildren(el('b', null, d.name), el('span', null, d.description || ''), ...(why ? [el('span', 'sb-desc-warn', why)] : []));
    }
    function renderDeps() {
      const q = filter.value.trim().toLowerCase();
      for (const d of allDeps()) if (!compatible(d)) chosen.delete(d.id);
      const rows = (meta?.dependencies || []).flatMap((g) => {
        const shown = g.values.filter((d) => !q || `${d.name} ${d.id} ${d.description || ''}`.toLowerCase().includes(q));
        if (!shown.length) return [];
        const open = !!q || !collapsed.has(g.name);
        const head = el('div', 'sb-dep-group');
        head.dataset.group = g.name;
        const count = g.values.filter((d) => chosen.has(d.id)).length;
        head.append(el('span', 'sb-twisty', open ? '▾' : '▸'), el('span', null, g.name), ...(count ? [el('span', 'sb-count', String(count))] : []));
        head.onclick = () => {
          if (collapsed.has(g.name)) collapsed.delete(g.name);
          else collapsed.add(g.name);
          renderDeps();
        };
        return [head, ...(open ? shown.map((d) => {
          const ok = compatible(d);
          const r = el('label', 'sb-dep');
          r.classList.toggle('disabled', !ok);
          const box = el('input');
          box.type = 'checkbox';
          box.value = d.id;
          box.checked = chosen.has(d.id);
          box.disabled = !ok;
          box.onchange = () => {
            if (box.checked) chosen.add(d.id);
            else chosen.delete(d.id);
            renderDeps();
          };
          r.onmouseenter = () => describe(d);
          box.onfocus = () => describe(d);
          r.append(box, el('span', null, d.name));
          return r;
        }) : [])];
      });
      deps.replaceChildren(...(rows.length ? rows : [el('div', 'muted', meta ? tr('No dependencies match.') : '')]));
      const list = allDeps().filter((d) => chosen.has(d.id));
      added.replaceChildren(...(list.length ? list.map((d) => {
        const chip = el('div', 'sb-chip');
        chip.dataset.id = d.id;
        const x = el('button', 'sb-chip-x', '×');
        x.title = tr('Remove');
        x.onclick = (e) => {
          e.preventDefault();
          chosen.delete(d.id);
          renderDeps();
        };
        chip.onmouseenter = () => describe(d);
        chip.append(el('span', null, d.name), x);
        return chip;
      }) : [el('div', 'muted', tr('No dependencies selected.'))]));
    }
    filter.oninput = renderDeps;
    bootVersion.onchange = renderDeps;
    // The newest Java version the chosen JDK runs.
    function pickJava() {
      const major = parseInt(jdk.chosen()?.version, 10);
      const fits = [...javaVersion.options].map((o) => o.value).filter((v) => !major || Number(v) <= major);
      if (fits.length) javaVersion.value = major ? fits.sort((a, b) => b - a)[0] : meta.javaVersion.default;
    }
    jdk.select.addEventListener('change', () => { if (meta) pickJava(); });
    const options = (select, s) => {
      select.replaceChildren(...s.values.map((v) => new Option(v.name, v.id)));
      select.value = s.default;
    };
    function say(text, warn = false, ...extra) {
      status.classList.toggle('warn', warn);
      status.replaceChildren(el('span', 'tc-offer-text', text), ...extra);
    }
    let loading = 0;
    async function load() {
      const mine = ++loading;
      meta = null;
      say(tr('Loading the options from {host}…', { host: host() }));
      let m;
      try {
        m = await ide.api.invoke('spring:metadata', server.value.trim());
      } catch (err) {
        if (mine !== loading) return;
        const retry = el('button', 'secondary', tr('Retry'));
        retry.id = 'npSpringRetry';
        retry.onclick = (e) => { e.preventDefault(); load(); };
        say(tr('Could not reach Spring Initializr: {error}', { error: ide.util.errorText(err) }), true, retry);
        return;
      }
      if (mine !== loading) return;
      meta = m;
      const pairs = (s) => s.values.map((v) => [v.id, v.name]);
      if (meta.language.values.length) language.set(pairs(meta.language), language.value() || meta.language.default);
      if (meta.packaging.values.length) packaging.set(pairs(meta.packaging), packaging.value() || meta.packaging.default);
      options(bootVersion, meta.bootVersion);
      options(javaVersion, meta.javaVersion);
      await tc.list('jdk');
      pickJava();
      renderDeps();
      say('');
    }
    server.addEventListener('change', load);
    ide.api.invoke('spring:defaultServer').then((url) => {
      if (!server.value) server.value = url;
      load();
    });

    function checkFirstPage() {
      if (!meta) throw new Error(tr('The Spring Initializr options have not loaded yet.'));
      const t = jdk.chosen();
      if (!t) throw new Error(tr('Choose a JDK, or download one.'));
      if ((parseInt(t.version, 10) || 0) < Number(javaVersion.value)) {
        throw new Error(tr('Java {version} needs JDK {version} or newer. Choose another JDK or Java version.', { version: javaVersion.value }));
      }
      if (!tc.javaPackage.test(group.value.trim())) throw new Error(tr('Enter a valid GroupId, such as org.example.'));
      if (!ARTIFACT.test(artifactId())) throw new Error(tr('Enter a valid artifact, such as demo.'));
      if (!tc.javaPackage.test(packageName())) throw new Error(tr('Enter a valid package name, such as com.example.demo.'));
    }

    let download = null; // the downloaded project, unpacked once the wizard has made the folder
    let mainFile = null;
    return {
      el: root,
      gitignore: tc.javaIgnore,
      pages: 2,
      showPage(n) {
        first.classList.toggle('hidden', n !== 0);
        second.classList.toggle('hidden', n !== 1);
        if (n === 1) { describe(null); filter.focus(); }
      },
      validatePage: async () => checkFirstPage(),
      main: () => mainFile || SPRING_BUILD_FILE[build.value()],
      async validate() {
        checkFirstPage();
        say(tr('Downloading the project from {host}…', { host: host() }));
        try {
          download = await ide.api.invoke('spring:download', {
            server: server.value.trim(), type: build.value(), language: language.value(), packaging: packaging.value(),
            bootVersion: bootVersion.value, javaVersion: javaVersion.value, groupId: group.value.trim(),
            artifactId: artifactId(), name: artifactId(), packageName: packageName(), dependencies: [...chosen],
          });
        } finally {
          say('');
        }
      },
      files: () => ({}),
      async setup(dir) {
        log(tr('Unpacking the project from Spring Initializr'));
        try {
          ({ main: mainFile } = await ide.api.invoke('spring:unpack', download, dir));
          return false;
        } catch (err) {
          log(ide.util.errorText(err));
          return true;
        }
      },
      async opened(dir) {
        ide.settings.set(tc.defaultKey('jdk', dir), jdk.chosen().id);
        ide.settings.set(SPRING_LAST, { server: server.value.trim(), language: language.value(), type: build.value(), group: group.value.trim(), packaging: packaging.value() });
        // Run (Shift+F10) starts the application through the build tool, like IntelliJ's Spring Boot configuration;
        // Launchers also lists it, and the project tree stays in view.
        const maven = build.value() === 'maven-project';
        tc.saveConfig({ ...tc.buildDefaults(), type: 'build', name: basename(mainFile || '').replace(/\.(java|kt|groovy)$/i, '') || artifactId(),
          tool: maven ? 'maven' : 'gradle', goals: maven ? 'spring-boot:run' : 'bootRun' });
        tc.sync(dir, maven ? 'maven' : 'gradle');
      },
    };
  }

  // ---------- the running application ----------
  // Spring Boot announces its port, not a URL: the Run tab (or, debugging, the Debug console: s is null) then says where
  // the application is, and the Run tab offers Open in Browser in its toolbar. Output arrives in chunks, so a line split
  // between two is joined first.
  function watchServer(s, con) {
    const append = con.append.bind(con);
    let tail = '';
    let found = false;
    con.append = (text, kind) => {
      append(text, kind);
      if (found || kind === 'sys') return;
      const lines = (tail + text).split(/\r?\n/);
      tail = lines.pop().slice(-300);
      for (const line of lines) {
        const busy = /Port (\d{2,5}) was already in use/.exec(line);
        if (busy) {
          found = true;
          append(`${tr('Port {port} is in use, perhaps by this application started from Launchers or another Run tab. Stop that one and run again, or set server.port in application.properties.', { port: busy[1] })}
`, 'err');
          return;
        }
        const m = /(?:Tomcat|Netty|Jetty|Undertow) (?:started|initialized) on port(?:\(s\))?:? (\d{2,5})|Started \S+ on port (\d{2,5})/.exec(line);
        if (!m) continue;
        found = true;
        const url = `http://localhost:${m[1] || m[2]}/`;
        append(`${tr('The application is running at {url}', { url })}\n`, 'sys');
        if (s) {
          s.setActions([{ icon: '🌐', title: tr('Open in Browser'), run: () => ide.api.invoke('shell:openExternal', url) }]);
          s.serverUrl = url;
        }
        return;
      }
    };
  }
  // ---------- run and debug from the application class ----------
  // The Spring Boot launcher the workspace scan found (pom.xml with spring-boot-maven-plugin, or a Gradle build with
  // the Spring Boot plugin), when the file is that project's application class.
  function springRun(path) {
    const e = ide.workspace?.entries().find((x) => (x.kind === 'maven' && x.goal === 'spring-boot:run') || (x.kind === 'gradle' && x.task === 'bootRun'));
    if (!e || !isUnder(path, joinPath(e.cwd, 'src\\main\\java'))) return null;
    const text = ide.findTab(path)?.doc?.model.getValue();
    const name = basename(path).replace(/\.java$/i, '');
    if (text ? !text.includes('@SpringBootApplication') : !/Application$/.test(name)) return null;
    return { type: 'build', name, tool: e.kind, goals: e.kind === 'maven' ? 'spring-boot:run' : 'bootRun', cwd: e.cwd === ide.root ? '' : e.cwd };
  }

  tc.addOutputWatcher(watchServer);
  tc.addRunResolver(springRun);

  // After Java in the New Project list, as IntelliJ IDEA lists its generators.
  const types = (ide.projectTypes ||= []);
  const java = types.findIndex((t) => t?.id === 'java');
  types.splice(java < 0 ? types.length : java + 1, 0,
    { id: 'spring', name: () => 'Spring Boot', icon: springIcon, main: 'pom.xml', defaultName: 'demo', form: springForm });
})();
