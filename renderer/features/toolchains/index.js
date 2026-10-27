// Java and C/C++: the built-in toolchains in the Install Manager (Eclipse Temurin JDK, w64devkit with GCC and GDB),
// New Project types (Java as a plain, Maven or Gradle project; C or C++), and the Java Application, Maven / Gradle and
// C/C++ Application run configurations, which compile with the chosen toolchain, put compiler errors in Problems and run
// the program in the Run tool window with standard input. Each project remembers its JDK and C/C++ toolchain
// (`toolchains.<kind>:<project>`); a configuration can name another one.
(() => {
  const { el, basename, dirname, joinPath, isUnder } = ide.util;
  const run = () => ide.run;
  const KINDS = {
    jdk: { builtin: 'jdk', item: 'toolchain:jdk', none: () => tr('No JDK was found on this computer.') },
    cpp: { builtin: 'cpp', item: 'toolchain:cpp', none: () => tr('No C/C++ compiler was found on this computer.') },
  };
  const quote = (a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const mb = (bytes) => tr('{size} MB download', { size: Math.round(bytes / 1048576) });
  const SKIP = /[\\/](out|build|target|bin|obj|cmake-build-[^\\/]*|\.gradle|\.mvn|\.?venv[^\\/]*|\.git|\.idea)[\\/]/i;

  // ---------- toolchains ----------
  const lists = {}; // kind -> Promise<toolchain[]>
  const cache = { jdk: [], cpp: [] }; // the last list, for the configuration form's synchronous options
  function list(kind, { fresh = false } = {}) {
    if (fresh || !lists[kind]) {
      lists[kind] = ide.api.invoke('toolchains:list', kind).then((l) => (cache[kind] = l), () => (cache[kind] = []));
    }
    return lists[kind];
  }
  function refresh() {
    builtinList = null;
    for (const kind of Object.keys(KINDS)) list(kind, { fresh: true });
    return Promise.all(Object.keys(KINDS).map((k) => lists[k])).then(() => ide.emit('toolchainsChanged'));
  }
  const label = (t) => (t.kind === 'jdk'
    ? `${tr('JDK {version}', { version: t.version || '?' })} · ${t.vendor || basename(t.home)}${t.builtin ? ' (PyIDE)' : ''}`
    : `${t.compiler} ${t.version || '?'} · ${t.vendor}${t.builtin ? ' (PyIDE)' : ''}`);
  const defaultKey = (kind, root = ide.root) => `toolchains.${kind}:${root}`;
  // The configuration's choice, the project's, the built-in one, then the first found.
  async function resolve(kind, id) {
    const all = await list(kind);
    const want = id || (ide.root && ide.settings.get(defaultKey(kind), '')) || '';
    return all.find((t) => t.id === want) || all.find((t) => t.builtin) || all[0] || null;
  }

  // ---------- Install Manager ----------
  let builtinList = null;
  const builtins = () => (builtinList ||= ide.api.invoke('installer:toolchains').then((l) => new Map(l.map((s) => [s.name, s]))));
  function toolchainItem(name, title, description, homepage) {
    const job = (kind) => async (log, progress, signal) => {
      if (!ide.installer?.job) throw new Error(tr('The Install Manager plugin is disabled.'));
      try { await ide.installer.job({ kind, name }, log, progress, signal); } finally { refresh(); }
    };
    return {
      id: `toolchain:${name}`, category: 'toolchains', name: title, description, homepage,
      async status() {
        const s = (await builtins()).get(name);
        return { installed: s.installed, version: s.version, size: mb(s.size),
          detail: s.installed ? s.home : tr('Portable install for your user account; no administrator rights needed.') };
      },
      install: job('toolchain-install'),
      uninstall: job('toolchain-uninstall'),
    };
  }
  (ide.installables ||= []).push(
    toolchainItem('jdk', 'Eclipse Temurin JDK', tr('OpenJDK build from Eclipse Adoptium (GPLv2 with the Classpath Exception), for Java projects.'), 'https://adoptium.net/'),
    toolchainItem('cpp', 'w64devkit', tr('GCC, G++, GDB and make for Windows in one portable folder, for C and C++ projects.'), 'https://github.com/skeeto/w64devkit'),
  );
  ide.emit('installablesChanged');

  // Installs the built-in toolchain from a wizard or a Run tab; onState gets the card's state while it runs.
  async function installBuiltin(kind, onState) {
    if (!ide.installer?.run) throw new Error(tr('The Install Manager plugin is disabled.'));
    const id = KINDS[kind].item;
    const timer = setInterval(() => onState?.(ide.installer.state(id)), 250);
    try {
      await ide.installer.run(id);
    } finally {
      clearInterval(timer);
    }
    const st = ide.installer.state(id);
    if (st.phase === 'failed') throw new Error(st.error);
    await refresh();
  }

  // A toolchain chooser for the wizard: a select, and Download for the built-in one while it is not installed.
  function chooser(kind, id, labelText) {
    const row = el('label', 'field');
    const box = el('div', 'field-row');
    const select = el('select');
    select.id = id;
    box.appendChild(select);
    row.append(el('span', null, labelText), box);
    const offer = el('div', 'tc-offer');
    offer.id = `${id}Offer`;
    const message = el('span', 'tc-offer-text');
    const button = el('button', 'secondary');
    button.id = `${id}Download`;
    offer.append(message, button);
    let installing = false;
    let failure = null; // the last download's error, shown until the next one
    async function fill() {
      const [all, b] = await Promise.all([list(kind), builtins().catch(() => new Map())]);
      const keep = select.value;
      select.replaceChildren(...all.map((t) => {
        const o = new Option(`${label(t)}   ${t.home}`, t.id);
        o.dataset.userText = '';
        return o;
      }));
      const builtin = all.find((t) => t.builtin);
      select.value = all.some((t) => t.id === keep) ? keep : (builtin || all[0])?.id || '';
      const s = b.get(KINDS[kind].builtin);
      offer.classList.toggle('hidden', !!s?.installed || !s);
      if (installing || !s) return;
      message.textContent = failure || (all.length ? '' : KINDS[kind].none());
      offer.classList.toggle('warn', !all.length);
      button.textContent = tr('Download {name} {version} ({size})', { name: s.title, version: s.version, size: `${Math.round(s.size / 1048576)} MB` });
    }
    button.onclick = async (e) => {
      e.preventDefault();
      installing = true;
      failure = null;
      button.disabled = true;
      message.textContent = tr('Downloading…');
      try {
        await installBuiltin(kind, (st) => {
          if (st.progress !== null) message.textContent = tr('Installing… {percent}%', { percent: Math.round(st.progress * 100) });
        });
      } catch (err) {
        failure = tr('Download failed: {error}', { error: String(err.message || err) });
      } finally {
        installing = false;
        button.disabled = false;
        await fill();
      }
    };
    fill();
    return { row, offer, select, chosen: () => cache[kind].find((t) => t.id === select.value) || null };
  }

  const radios = (name, choices, value, onchange) => {
    const box = el('div', 'np-modes');
    for (const [v, text] of choices) {
      const r = el('label', 'np-radio');
      const i = el('input');
      i.type = 'radio';
      i.name = name;
      i.value = v;
      i.checked = v === value;
      i.onchange = onchange;
      r.append(i, el('span', null, text));
      box.appendChild(r);
    }
    return { el: box, value: () => box.querySelector('input:checked').value };
  };
  const section = (title, ...children) => {
    const s = el('fieldset', 'np-section');
    s.append(el('legend', null, title), ...children);
    return s;
  };
  const field = (text, control) => {
    const r = el('label', 'field');
    const box = el('div', 'field-row');
    box.appendChild(control);
    r.append(el('span', null, text), box);
    return r;
  };

  // Saves the project's first run configuration and makes it the selected one.
  function saveConfig(cfg) {
    if (!run()) return;
    const saved = run().addTemporary(cfg);
    saved.temporary = false;
    run().select(saved.id);
  }

  // ---------- New Project: Java ----------
  const JAVA_MAIN = (pkg) => `${pkg ? `package ${pkg};\n\n` : ''}public class Main {
    public static void main(String[] args) {
        System.out.println("Hello and welcome!");

        for (int i = 1; i <= 5; i++) {
            System.out.println("i = " + i);
        }
    }
}
`;
  const POM = (group, artifact, release) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${group}</groupId>
    <artifactId>${artifact}</artifactId>
    <version>1.0-SNAPSHOT</version>

    <properties>
        <maven.compiler.release>${release}</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <build>
        <plugins>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.5.0</version>
                <configuration>
                    <mainClass>${group}.Main</mainClass>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;
  const GRADLE = (group, release) => `plugins {
    id 'application'
}

group = '${group}'
version = '1.0-SNAPSHOT'

repositories {
    mavenCentral()
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(${release})
    }
}

application {
    mainClass = '${group}.Main'
}
`;
  const JAVA_IGNORE = 'out/\ntarget/\nbuild/\n.gradle/\n.idea/\n*.class\n';
  const PACKAGE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

  function javaForm({ name }) {
    const jdk = chooser('jdk', 'npJdk', tr('JDK:'));
    const group = el('input');
    group.id = 'npGroup';
    group.value = 'org.example';
    const build = radios('npBuild', [['plain', 'IntelliJ'], ['maven', 'Maven'], ['gradle', 'Gradle']], 'plain', () => sync());
    const groupRow = field(tr('GroupId:'), group);
    const note = el('div', 'np-preview muted');
    const root = el('div', 'tc-np');
    root.id = 'npJava';
    root.append(section(tr('Build system'), build.el, groupRow, note), jdk.row, jdk.offer);
    function sync() {
      const b = build.value();
      groupRow.classList.toggle('hidden', b === 'plain');
      note.textContent = b === 'maven' ? tr('Maven goals run from the Launchers tool window with mvn on PATH.')
        : b === 'gradle' ? tr('Gradle tasks run from the Launchers tool window with gradle on PATH.') : '';
    }
    sync();
    const pkg = () => (build.value() === 'plain' ? '' : group.value.trim());
    const srcRoot = () => (build.value() === 'plain' ? 'src' : 'src\\main\\java');
    const mainRel = () => [srcRoot(), ...(pkg() ? pkg().split('.') : []), 'Main.java'].join('\\');
    const release = () => String(parseInt(jdk.chosen()?.version, 10) || 21);
    return {
      el: root,
      gitignore: JAVA_IGNORE,
      main: mainRel,
      async validate() {
        if (!jdk.chosen()) throw new Error(tr('Choose a JDK, or download one.'));
        if (build.value() !== 'plain' && !PACKAGE.test(group.value.trim())) throw new Error(tr('Enter a valid GroupId, such as org.example.'));
      },
      files() {
        const files = { [mainRel()]: JAVA_MAIN(pkg()) };
        if (build.value() === 'maven') Object.assign(files, { 'pom.xml': POM(pkg(), name(), release()), 'src\\main\\resources': null, 'src\\test\\java': null });
        if (build.value() === 'gradle') Object.assign(files, { 'build.gradle': GRADLE(pkg(), release()), 'settings.gradle': `rootProject.name = '${name()}'\n`, 'src\\main\\resources': null, 'src\\test\\java': null });
        return files;
      },
      async opened(dir) {
        ide.settings.set(defaultKey('jdk', dir), jdk.chosen().id);
        saveConfig({ ...javaType.defaults(), type: 'java', name: 'Main', mainClass: pkg() ? `${pkg()}.Main` : 'Main', sourceRoot: srcRoot() });
      },
    };
  }

  // ---------- New Project: C / C++ ----------
  const C_MAIN = `#include <stdio.h>

int main(void) {
    printf("Hello, World!\\n");
    return 0;
}
`;
  const CPP_MAIN = `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`;
  const STANDARDS = { cpp: ['c++17', 'c++20', 'c++23'], c: ['c11', 'c17', 'c23'] };

  function cppForm({ name }) {
    const tc = chooser('cpp', 'npToolchain', tr('Toolchain:'));
    const standard = el('select');
    standard.id = 'npStandard';
    const lang = radios('npLang', [['cpp', 'C++'], ['c', 'C']], 'cpp', () => sync());
    function sync() {
      const list = STANDARDS[lang.value()];
      standard.replaceChildren(...list.map((s) => new Option(s.toUpperCase().replace('C++', 'C++ '), s)));
      standard.value = list[1];
    }
    sync();
    const root = el('div', 'tc-np');
    root.id = 'npCpp';
    root.append(section(tr('Language'), lang.el, field(tr('Language standard:'), standard)), tc.row, tc.offer);
    const main = () => (lang.value() === 'c' ? 'main.c' : 'main.cpp');
    return {
      el: root,
      gitignore: 'build/\ncmake-build-*/\n.idea/\n*.exe\n*.o\n',
      main,
      async validate() {
        if (!tc.chosen()) throw new Error(tr('Choose a toolchain, or download one.'));
      },
      files: () => ({ [main()]: lang.value() === 'c' ? C_MAIN : CPP_MAIN }),
      async opened(dir) {
        ide.settings.set(defaultKey('cpp', dir), tc.chosen().id);
        saveConfig({ ...cppType.defaults(), type: 'cpp', name: name(), output: `build\\${name()}.exe`, flags: `-std=${standard.value} -g -Wall` });
      },
    };
  }

  (ide.projectTypes ||= []).push(
    { id: 'java', name: () => 'Java', icon: () => ide.fileIcon('Main.java'), main: 'src\\Main.java', form: javaForm },
    { id: 'cpp', name: () => 'C/C++', icon: () => ide.fileIcon('main.cpp'), main: 'main.cpp', form: cppForm },
  );

  // ---------- building ----------
  // javac: "path:line: error: message", then the source line and a caret under the column.
  function parseJavac(out) {
    const lines = out.split(/\r?\n/);
    const items = [];
    lines.forEach((line, i) => {
      const m = /^(.+\.java):(\d+): (error|warning): (.*)$/.exec(line);
      if (!m) return;
      const caret = lines.slice(i + 1, i + 4).find((l) => /^\s*\^\s*$/.test(l));
      items.push({ path: m[1], line: Number(m[2]), col: caret ? caret.indexOf('^') + 1 : 1, msg: m[4], severity: m[3] });
    });
    return items;
  }
  // GCC and Clang: "path:line:col: error: message" (the path may start with a drive letter).
  function parseGcc(out) {
    const items = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/.exec(line);
      if (m) items.push({ path: m[1], line: Number(m[2]), col: Number(m[3]), msg: m[5], severity: m[4] === 'warning' ? 'warning' : 'error' });
    }
    return items;
  }
  function publish(source, items) {
    ide.problems.clear(source);
    const byFile = new Map();
    for (const it of items) {
      const p = it.path.replace(/\//g, '\\');
      const abs = /^[A-Za-z]:\\|^\\\\/.test(p) || !ide.root ? p : joinPath(ide.root, p);
      if (!byFile.has(abs)) byFile.set(abs, []);
      byFile.get(abs).push({ line: it.line, col: it.col, msg: it.msg, severity: it.severity });
    }
    for (const [p, list] of byFile) ide.problems.set(source, p, list);
  }

  // How a build in a Run tab learns it was stopped (the session is still starting, so Stop only marks cancelStart) and
  // marks the tab failed.
  const runControl = (s) => ({
    cancelled: () => s.cancelStart || s.closed,
    acknowledge: () => { s.cancelStart = false; },
    failed: () => s.setIcon('▶', 'failed'),
  });
  // A build in the Debug tool window: cancelled() says the debug session it belongs to was stopped or replaced.
  const debugControl = (cancelled) => ({ cancelled, acknowledge() {}, failed() {} });

  // Runs a compiler into the console before the program starts; Stop during the build ends it.
  // ctl: runControl or debugControl. -> true when it succeeded.
  async function compile(ctl, con, tc, { cmd, args, files, cwd, source, parse, makeDirs }) {
    con.append(`${[joinPath(tc.bin, `${cmd}.exe`), ...args].map(quote).join(' ')} ${tr('({count} source files)', { count: files.length })}\n`, 'sys');
    let id;
    try {
      id = await ide.api.invoke('toolchains:start', { toolchain: tc, cmd, args, argfile: files, cwd, makeDirs });
    } catch (err) {
      con.append(`${err.message}\n`, 'err');
      return false;
    }
    let out = '';
    const code = await new Promise((resolve) => {
      const timer = setInterval(() => { if (ctl.cancelled()) ide.proc.kill(id); }, 200);
      ide.proc.attach(id, {
        data: (text, stream) => { out += text; con.append(text, stream === 'err' ? 'err' : null); },
        exit: (c) => { clearInterval(timer); resolve(c); },
      });
    });
    const items = parse(out);
    publish(source, items);
    if (ctl.cancelled()) {
      ctl.acknowledge();
      con.append(`${tr('Build cancelled.')}\n`, 'sys');
      ctl.failed();
      return false;
    }
    if (code !== 0) {
      const errors = items.filter((it) => it.severity === 'error').length;
      con.append(`\n${errors ? tr('Build failed with {count} errors. They are listed in the Problems tool window.', { count: errors }) : tr('Build failed (exit code {code})', { code })}\n`, 'err');
      ctl.failed();
      if (errors) ide.toolWindows?.get('Problems')?.show();
      return false;
    }
    return true;
  }

  async function launch(s, con, tc, program, args, cwd, env) {
    con.append(`${[program, ...args].map(quote).join(' ')}\n`, 'sys');
    const id = await ide.api.invoke('toolchains:start', { toolchain: tc, cmd: program, args, cwd, env });
    s.attach(id);
  }

  // The Run tab says what is missing and offers the built-in toolchain.
  function missing(s, con, kind) {
    con.append(`${KINDS[kind].none()} ${tr('Download one in the Install Manager, or install one and choose it in the configuration.')}\n`, 'err');
    s.setActions([{ icon: '⤓', title: kind === 'jdk' ? tr('Download JDK') : tr('Download C/C++ Toolchain'), run: () => {
      ide.installer?.open('toolchains');
      installBuiltin(kind).catch(() => {});
    } }]);
  }

  const toolchainOptions = (kind) => () => [['', tr('Project default')], ...cache[kind].map((t) => [t.id, label(t)])];
  async function sourcesUnder(dir, ext) {
    let files = [];
    try { files = await ide.api.walk(dir); } catch {}
    return files.filter((f) => ext.test(f) && !SKIP.test(f.slice(dir.length)));
  }

  // Other plugins' say in what runs (spring-boot): a resolver may hand a .java file to another configuration (an
  // application class that runs through its build tool), and an output watcher sees a Maven / Gradle run's or debug
  // session's console (s is the Run session, null in the Debug console) as it fills.
  const runResolvers = [];
  const outputWatchers = [];

  // ---------- run configuration: Java Application ----------
  const isFileMode = (c) => c.runMode === 'file';
  const javaType = {
    type: 'java', title: tr('Java Application'), icon: '☕', needsInterp: false,
    fields: [
      { key: 'runMode', label: tr('Run'), kind: 'select', options: () => [['class', tr('Main class')], ['file', tr('Single source file')]] },
      { key: 'mainClass', label: tr('Main class'), placeholder: 'org.example.Main', shown: (c) => !isFileMode(c) },
      { key: 'sourceRoot', label: tr('Source root'), placeholder: tr('Defaults to src'), shown: (c) => !isFileMode(c) },
      { key: 'classpath', label: tr('Classpath'), placeholder: tr('Extra JAR files or folders, separated by ;'), shown: (c) => !isFileMode(c) },
      { key: 'file', label: tr('Source file'), placeholder: 'Main.java', browse: [{ name: 'Java', extensions: ['java'] }], shown: isFileMode },
      { key: 'vmOptions', label: tr('VM options'), placeholder: '-Xmx512m' },
      { key: 'params', label: tr('Program arguments') },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project root') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      { key: 'jdk', label: tr('JDK'), kind: 'select', options: toolchainOptions('jdk') },
    ],
    defaults: () => ({ runMode: 'class', mainClass: '', sourceRoot: '', classpath: '', file: '', vmOptions: '', params: '', cwd: '', env: '', jdk: '' }),
    identity: (c) => (isFileMode(c) ? `file:${run().resolvePath(c.file).toLowerCase()}` : `class:${(c.mainClass || '').trim()}`),
    file: (c) => (isFileMode(c) ? run().resolvePath(c.file) : null),
    // A class under a source root (src\main\java, src) runs by name after a build; any other file as java File.java.
    forFile(path) {
      if (!/\.java$/i.test(path)) return null;
      for (const resolver of runResolvers) {
        const cfg = resolver(path);
        if (cfg) return cfg;
      }
      const name = basename(path).replace(/\.java$/i, '');
      const roots = ide.root ? [joinPath(ide.root, 'src\\main\\java'), joinPath(ide.root, 'src\\test\\java'), joinPath(ide.root, 'src')] : [];
      const root = roots.find((r) => isUnder(path, r));
      if (!root) return { type: 'java', name, runMode: 'file', file: path };
      const cls = path.slice(root.length + 1).replace(/\.java$/i, '').split(/[\\/]/).join('.');
      return { type: 'java', name, runMode: 'class', mainClass: cls, sourceRoot: root.slice(ide.root.length + 1) };
    },
    async start(cfg, s) {
      const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
      const jdk = await resolve('jdk', cfg.jdk);
      if (!jdk) return missing(s, con, 'jdk');
      const cmd = await javaCommand(cfg, con, jdk, runControl(s), []);
      if (cmd) await launch(s, con, jdk, cmd.java, cmd.args, cmd.cwd, cmd.env);
    },
    // Debug (Shift+F9): the same build, then java with the JDWP agent listening for the debugger, suspended until it
    // has set the breakpoints.
    debug(cfg) {
      return ide.debugger.debugJvm({
        rerun: () => run().debugConfig(cfg),
        async launch({ con, port, cancelled }) {
          const jdk = await resolve('jdk', cfg.jdk);
          if (!jdk) {
            con.append(`${KINDS.jdk.none()} ${tr('Download one in the Install Manager, or install one and choose it in the configuration.')}\n`, 'err');
            return null;
          }
          const agent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`;
          const cmd = await javaCommand(cfg, con, jdk, debugControl(cancelled), [agent]);
          if (!cmd || cancelled()) return null;
          con.append(`${[cmd.java, ...cmd.args].map(quote).join(' ')}\n`, 'sys');
          const procId = await ide.api.invoke('toolchains:start', { toolchain: jdk, cmd: cmd.java, args: cmd.args, cwd: cmd.cwd, env: cmd.env });
          return { procId, sourceRoots: cmd.sourceRoots };
        },
      });
    },
  };

  // ---------- run configuration: Maven / Gradle ----------
  // Goals or tasks run through the project's wrapper (mvnw.cmd, gradlew.bat) or mvn / gradle on PATH, with the
  // project's JDK as JAVA_HOME. A Spring Boot project runs this way: its classpath comes from the build tool.
  const buildType = {
    type: 'build', title: tr('Maven / Gradle'), icon: '🧱', needsInterp: false,
    fields: [
      { key: 'tool', label: tr('Build tool'), kind: 'select', options: () => [['maven', 'Maven'], ['gradle', 'Gradle']] },
      { key: 'goals', label: tr('Goals or tasks'), placeholder: 'spring-boot:run' },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project root') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      { key: 'jdk', label: tr('JDK'), kind: 'select', options: toolchainOptions('jdk') },
    ],
    defaults: () => ({ tool: 'maven', goals: '', cwd: '', env: '', jdk: '' }),
    identity: (c) => `${c.tool}:${(c.goals || '').trim()}|${(c.cwd || '').trim().toLowerCase()}`,
    file: () => null,
    async start(cfg, s) {
      const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
      if (!(cfg.goals || '').trim()) return con.append(`${tr('No goals or tasks given. Edit the configuration first.')}\n`, 'err');
      const r = run();
      const cwd = r.resolvePath(cfg.cwd) || ide.root;
      if (!cwd) return con.append(`${tr('Open a project first.')}\n`, 'err');
      // Without a JDK the computer's own JAVA_HOME and PATH apply.
      const jdk = await resolve('jdk', cfg.jdk);
      // Two wrappers would download into the same cache at once: the run waits for New Project's download, and Stop
      // cancels the run, not the download.
      if (!(await afterSync(cwd, (text) => con.append(text, 'sys'), () => s.cancelStart || s.closed))) {
        s.cancelStart = false;
        con.append(`${tr('Run cancelled.')}\n`, 'sys');
        s.setIcon('▶', 'failed');
        return;
      }
      const { id, command, firstRun } = await ide.api.invoke('toolchains:build', { tool: cfg.tool, goals: cfg.goals, cwd, env: r.parseEnv(cfg.env), jdk: jdk && { home: jdk.home } });
      con.append(`${command}\n`, 'sys');
      if (firstRun && !synced.has(cwd.toLowerCase())) {
        const tool = cfg.tool === 'maven' ? 'Maven' : 'Gradle';
        con.append(`${tr('The first run downloads {tool} and the project\'s dependencies, which can take a few minutes.', { tool })}\n`, 'sys');
      }
      for (const watch of outputWatchers) watch(s, con);
      s.attach(id);
    },
    // Debug (Shift+F9): the same goals with the application's JVM listening for the debugger (toolchains:build's
    // debugPort), like IntelliJ's Spring Boot debug. The build tool may download and compile for minutes before that
    // JVM listens, so the debugger waits as long as the build runs (up to 30 minutes).
    debug(cfg) {
      return ide.debugger.debugJvm({
        rerun: () => run().debugConfig(cfg),
        async launch({ con, port, cancelled }) {
          if (!(cfg.goals || '').trim()) {
            con.append(`${tr('No goals or tasks given. Edit the configuration first.')}\n`, 'err');
            return null;
          }
          const r = run();
          const cwd = r.resolvePath(cfg.cwd) || ide.root;
          if (!cwd) { con.append(`${tr('Open a project first.')}\n`, 'err'); return null; }
          const jdk = await resolve('jdk', cfg.jdk);
          if (!(await afterSync(cwd, (text) => con.append(text, 'sys'), cancelled)) || cancelled()) return null;
          const { id, command, firstRun } = await ide.api.invoke('toolchains:build', {
            tool: cfg.tool, goals: cfg.goals, cwd, env: r.parseEnv(cfg.env), jdk: jdk && { home: jdk.home }, debugPort: port,
          });
          con.append(`${command}\n`, 'sys');
          if (firstRun && !synced.has(cwd.toLowerCase())) {
            const tool = cfg.tool === 'maven' ? 'Maven' : 'Gradle';
            con.append(`${tr('The first run downloads {tool} and the project\'s dependencies, which can take a few minutes.', { tool })}\n`, 'sys');
          }
          for (const watch of outputWatchers) watch(null, con);
          const sourceRoots = ['src\\main\\java', 'src\\main\\kotlin', 'src\\main\\groovy'].map((d) => joinPath(cwd, d));
          return { procId: id, sourceRoots, timeoutMs: 30 * 60 * 1000 };
        },
      });
    },
  };
  // ---------- dependency download ----------
  // Like IntelliJ's import of a new Maven or Gradle project: the wrapper downloads the build tool and the dependencies
  // in the background (toolchains:build with sync), shown as a status bar task with Cancel and as a "Sync: <project>"
  // tab in the Run tool window (Stop cancels too, Rerun starts it again). Not in Safe Mode.
  const syncs = new Map(); // lower-cased folder -> {done: Promise}, while its download runs
  const synced = new Set(); // lower-cased folders downloaded in this session: their first run needs no notice
  async function syncDependencies(dir, tool) {
    const key = dir.toLowerCase();
    if (ide.trusted === false || syncs.has(key) || !run()) return;
    let finished;
    syncs.set(key, { done: new Promise((r) => (finished = r)) });
    const name = basename(dir);
    const s = run().outputSession(`sync:${key}`, tr('Sync: {name}', { name }));
    s.host.replaceChildren();
    const con = s.console();
    s.rerun = () => syncDependencies(dir, tool);
    let id = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (id !== null) ide.proc.kill(id);
    };
    s.kill = stop;
    const task = ide.tasks.start({ title: tr('Downloading dependencies…'), text: name, onCancel: stop });
    const show = { label: tr('Show Output'), run: () => run().show(s) };
    const end = (ok) => {
      task.done();
      syncs.delete(key);
      if (ok) synced.add(key);
      finished(ok);
    };
    // The status bar shows the latest line (Maven's "Downloading from central: …", Gradle's "> Task :compileJava"), a
    // URL as its file name.
    const append = con.append.bind(con);
    let tail = '';
    con.append = (text, kind) => {
      append(text, kind);
      if (kind === 'sys') return;
      const lines = (tail + text).split(/\r?\n/);
      tail = lines.pop().slice(-300);
      const last = lines.map((l) => l.trim().replace(/\bhttps?:\/\/\S*\/([^\s/]+)/g, '$1')).filter(Boolean).pop();
      if (last) task.update({ text: `${name}: ${last.length > 120 ? `${last.slice(0, 117)}…` : last}` });
    };
    try {
      const jdk = await resolve('jdk');
      const r = await ide.api.invoke('toolchains:build', { tool, sync: true, cwd: dir, jdk: jdk && { home: jdk.home } });
      id = r.id;
      con.append(`${r.command}\n`, 'sys');
      con.append(`${tr('Downloading {tool} and the project\'s dependencies, so the first run starts quickly.', { tool: tool === 'maven' ? 'Maven' : 'Gradle' })}\n`, 'sys');
      if (stopped) ide.proc.kill(id);
    } catch (err) {
      con.append(`${ide.util.errorText(err)}\n`, 'err');
      end(false);
      return;
    }
    s.attach(id, {
      onExit(code) {
        if (stopped) {
          con.append(`${tr('Dependency download cancelled.')}\n`, 'sys');
          s.setIcon('▶', 'failed');
          return end(false);
        }
        if (code === 0) {
          con.append(`${tr('Dependencies downloaded.')}\n`, 'sys');
          ide.notifications?.notify({ title: tr('Dependencies downloaded'), text: name, kind: 'ok', group: 'Build Tools', raw: true, actions: [show] });
          return end(true);
        }
        con.append(`${tr('The dependency download failed. Running the project downloads them again.')}\n`, 'err');
        ide.notifications?.notify({ title: tr('Dependency download failed'), text: tr('{name}: exit code {code}', { name, code: code ?? 1 }), kind: 'error', group: 'Build Tools', raw: true, actions: [show] });
        end(false);
      },
    });
  }
  // Waits for a download running in dir; say(text) tells why. -> false when stopped() turned true first.
  async function afterSync(dir, say, stopped = () => false) {
    const job = syncs.get(dir.toLowerCase());
    if (!job) return true;
    say(`${tr('Waiting for the dependency download to finish. To run now, cancel Downloading dependencies… in the status bar.')}\n`);
    return new Promise((resolve) => {
      const timer = setInterval(() => { if (stopped()) { clearInterval(timer); resolve(false); } }, 200);
      job.done.then(() => { clearInterval(timer); resolve(true); });
    });
  }

  // What a Java Application configuration runs, after building it (Main class mode): {java, args, cwd, env,
  // sourceRoots}, or null when it cannot run (the reason is in con). agent: JVM options that go first (the debugger's).
  async function javaCommand(cfg, con, jdk, ctl, agent) {
    const r = run();
    const params = r.parseArgs(cfg.params);
    const env = r.parseEnv(cfg.env);
    // Java writes piped output in the system code page (CP949 on Korean Windows) unless told otherwise.
    const vm = [...agent, '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', ...r.parseArgs(cfg.vmOptions)];
    const java = joinPath(jdk.bin, 'java.exe');
    if (isFileMode(cfg)) {
      const file = r.resolvePath(cfg.file);
      if (!file) { con.append(`${tr('Source file is not specified. Edit the configuration first.')}\n`, 'err'); return null; }
      const cwd = r.resolvePath(cfg.cwd) || ide.root || dirname(file);
      return { java, args: [...vm, file, ...params], cwd, env, sourceRoots: [dirname(file)] };
    }
    if (!(cfg.mainClass || '').trim()) { con.append(`${tr('Main class is not specified. Edit the configuration first.')}\n`, 'err'); return null; }
    if (!ide.root) { con.append(`${tr('Open a project first.')}\n`, 'err'); return null; }
    const srcRoot = r.resolvePath(cfg.sourceRoot || 'src');
    const sources = await sourcesUnder(srcRoot, /\.java$/i);
    if (!sources.length) { con.append(`${tr('No .java files were found in {path}.', { path: srcRoot })}\n`, 'err'); return null; }
    const out = joinPath(ide.root, `out\\production\\${basename(ide.root)}`);
    const cp = (cfg.classpath || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => r.resolvePath(p));
    const ok = await compile(ctl, con, jdk, {
      cmd: 'javac', source: 'javac', parse: parseJavac, files: sources, cwd: ide.root,
      args: ['-J-Dstdout.encoding=UTF-8', '-J-Dstderr.encoding=UTF-8', '-encoding', 'UTF-8', '-g', '-d', out, ...(cp.length ? ['-cp', cp.join(';')] : [])],
    });
    if (!ok) return null;
    return { java, args: [...vm, '-cp', [out, ...cp].join(';'), cfg.mainClass.trim(), ...params], cwd: r.resolvePath(cfg.cwd) || ide.root, env, sourceRoots: [srcRoot] };
  }

  // ---------- run configuration: C/C++ Application ----------
  const C_SOURCE = /\.(c|cc|cpp|cxx|c\+\+)$/i;
  const cppType = {
    type: 'cpp', title: tr('C/C++ Application'), icon: '⚙', needsInterp: false,
    fields: [
      { key: 'sources', label: tr('Source files'), placeholder: tr('Defaults to every .c and .cpp file in the project') },
      { key: 'output', label: tr('Executable'), placeholder: 'build\\app.exe' },
      { key: 'flags', label: tr('Compiler options'), placeholder: '-std=c++20 -g -Wall' },
      { key: 'params', label: tr('Program arguments') },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project root') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      { key: 'toolchain', label: tr('Toolchain'), kind: 'select', options: toolchainOptions('cpp') },
    ],
    defaults: () => ({ sources: '', output: '', flags: '-g -Wall', params: '', cwd: '', env: '', toolchain: '' }),
    identity: (c) => `${(c.sources || '').trim().toLowerCase()}|${(c.output || '').trim().toLowerCase()}`,
    file: () => null,
    // A file in the project builds the project's program; any other file alone.
    forFile(path) {
      if (!C_SOURCE.test(path)) return null;
      if (ide.root && isUnder(path, ide.root)) return { type: 'cpp', name: basename(ide.root), output: `build\\${basename(ide.root)}.exe` };
      const name = basename(path).replace(C_SOURCE, '');
      return { type: 'cpp', name, sources: quote(path), output: joinPath(dirname(path), `${name}.exe`) };
    },
    async start(cfg, s) {
      const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
      const tc = await resolve('cpp', cfg.toolchain);
      if (!tc) return missing(s, con, 'cpp');
      const r = run();
      const sources = (cfg.sources || '').trim()
        ? r.parseArgs(cfg.sources).map((p) => r.resolvePath(p))
        : ide.root ? await sourcesUnder(ide.root, C_SOURCE) : [];
      if (!sources.length) return con.append(`${tr('No C or C++ source files were found.')}\n`, 'err');
      const cpp = sources.some((f) => !/\.c$/i.test(f));
      if (cpp && !tc.cxx) return con.append(`${tr('{compiler} in {path} has no C++ compiler.', { compiler: tc.compiler, path: tc.bin })}\n`, 'err');
      const name = ide.root ? basename(ide.root) : basename(sources[0]).replace(C_SOURCE, '');
      const output = r.resolvePath(cfg.output || `build\\${name}.exe`);
      const ok = await compile(runControl(s), con, tc, {
        cmd: basename(cpp ? tc.cxx : tc.cc).replace(/\.exe$/i, ''), source: 'gcc', parse: parseGcc, files: sources,
        cwd: ide.root || dirname(sources[0]), makeDirs: [dirname(output)],
        args: [...r.parseArgs(cfg.flags), '-fdiagnostics-color=never', '-o', output],
      });
      if (!ok) return;
      await launch(s, con, tc, output, r.parseArgs(cfg.params), r.resolvePath(cfg.cwd) || ide.root || dirname(output), r.parseEnv(cfg.env));
    },
  };

  // ---------- registration ----------
  const MAIN_LINE = { java: /^\s*(public\s+)?(static\s+)?void\s+main\s*\(/, cpp: /^\s*int\s+main\s*\(/ };
  if (run()) {
    run().registerType(javaType);
    run().registerType(buildType);
    run().registerType(cppType);
    // main methods and functions get a run icon, like IntelliJ IDEA and CLion.
    run().registerGutterProvider((model, path) => {
      const type = /\.java$/i.test(path) ? javaType : C_SOURCE.test(path) ? cppType : null;
      if (!type) return [];
      const re = MAIN_LINE[type.type];
      const items = [];
      model.getLinesContent().forEach((text, i) => {
        if (re.test(text)) items.push({ line: i + 1, title: type.forFile(path).name, config: () => type.forFile(path) });
      });
      return items;
    });
    ide.registerTreeAction({
      title: tr("Run '…'"),
      keyAction: 'RunClass',
      when: (e) => !e.dir && (/\.java$/i.test(e.name) || C_SOURCE.test(e.name)),
      run: (e) => run().runContext((/\.java$/i.test(e.name) ? javaType : cppType).forFile(e.path)),
    });
    ide.registerTreeAction({
      title: tr("Debug '…'"),
      when: (e) => !e.dir && /\.java$/i.test(e.name) && !!ide.debugger?.debugJvm,
      run: (e) => run().debugConfig(run().addTemporary(javaType.forFile(e.path))),
    });
  }
  ide.on('projectOpened', () => refresh());
  list('jdk');
  list('cpp');

  // installable(name, title, description, homepage): an Install Manager item for another built-in download of
  // main/installer/toolchains.js (java-lsp's Eclipse JDT Language Server).
  ide.toolchains = { list, refresh, resolve, label, install: installBuiltin, installable: toolchainItem, parseJavac, parseGcc,
    sync: syncDependencies, afterSync,
    // For plugins that add Java project types and run behaviour (spring-boot): the wizard's controls, the project's
    // default JDK key, saving a run configuration, the Maven / Gradle type's defaults, and the hooks above.
    ui: { chooser, radios, field, section }, defaultKey, saveConfig, javaIgnore: JAVA_IGNORE, javaPackage: PACKAGE,
    buildDefaults: () => buildType.defaults(),
    addRunResolver: (fn) => runResolvers.push(fn), addOutputWatcher: (fn) => outputWatchers.push(fn) };
})();
