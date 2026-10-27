// Code intelligence for Java from the Eclipse JDT Language Server (main/features/java-lsp.js runs it): completion,
// errors and warnings as you type, hover documentation, Go to Declaration (JDK and library classes open read-only),
// Find Usages, Rename, Optimize Imports, Reformat Code and quick fixes, through the lsp plugin's client. It starts when
// a trusted project has a Maven or Gradle build file, a JDK chosen in New Project, or a Java file open, and runs on the
// project's JDK when that is 21 or later, else on another JDK 21+ (the built-in Temurin).
(() => {
  if (!ide.lsp?.createClient || !ide.toolchains) return;
  const { basename, joinPath } = ide.util;
  const monaco = ide.monaco;
  const ITEM = 'toolchain:jdtls';
  const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
  const major = (version) => parseInt(String(version || '').replace(/^1\./, ''), 10) || 0;

  const item = ide.toolchains.installable('jdtls', 'Eclipse JDT Language Server',
    tr('Completion, error checking, navigation and refactoring for Java (EPL 2.0). Runs on a JDK 21 or later.'),
    'https://github.com/eclipse-jdtls/eclipse.jdt.ls');
  // A running server holds its jars open, and Windows would leave the folder half removed.
  const removeFiles = item.uninstall;
  item.uninstall = (...args) => { java.stop(); return removeFiles(...args); };
  (ide.installables ||= []).push(item);
  ide.emit('installablesChanged');

  // A project JDT LS is worth its memory for: a build file, a JDK chosen for it, or a Java file open.
  async function isJavaProject(client) {
    if (client.docsList().length) return true;
    if (ide.settings.get(`toolchains.jdk:${ide.root}`, '')) return true;
    const found = await Promise.all(BUILD_FILES.map((f) => ide.api.exists(joinPath(ide.root, f)).catch(() => false)));
    return found.some(Boolean);
  }

  // The project's JDK when it can run the server, else the newest JDK 21+ found.
  async function runtimes() {
    const project = await ide.toolchains.resolve('jdk');
    const all = await ide.toolchains.list('jdk');
    const runner = major(project?.version) >= 21 ? project
      : all.filter((t) => major(t.version) >= 21).sort((a, b) => major(b.version) - major(a.version) || (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0))[0];
    return { project, runner };
  }

  // ---------- offers: the server or a JDK to run it ----------
  const offered = new Set(); // once per session each
  function offer(what) {
    if (offered.has(what)) return;
    offered.add(what);
    const missing = what === 'missing';
    ide.notifications?.notify({
      title: tr('Java code insight'), kind: 'info', group: 'Java',
      text: missing
        ? tr('Completion, error checking and navigation for Java need the Eclipse JDT Language Server (about 50 MB).')
        : tr('The Java language server needs a JDK 21 or later to run.'),
      actions: [{ label: missing ? tr('Download') : tr('Download JDK'), run: (note) => { note.expire(); install(what); } }],
    });
  }
  async function install(what) {
    try {
      if (what === 'missing') {
        await ide.installer?.run(ITEM);
        if (ide.installer?.state(ITEM)?.phase === 'failed') return;
      } else {
        await ide.toolchains.install('jdk');
      }
    } catch (err) {
      console.warn('java-lsp install failed', err);
      return;
    }
    java.restart();
  }

  // ---------- classes outside the project (jdt://) ----------
  // JDT LS answers Go to Declaration on a JDK or library class with a jdt:// uri, whose source (or a decompiled
  // outline) java/classFileContents gives. It opens read-only, as IntelliJ IDEA shows library sources.
  const originals = new Map(); // Monaco's spelling of a jdt uri -> the server's
  // The class models Ctrl+hover, peek and Go to Declaration loaded, oldest first; only the last MAX_CLASSES stay,
  // besides those a tab shows.
  const classModels = new Map();
  const MAX_CLASSES = 20;
  const shown = (model) => ide.tabs.some((t) => t.editor?.getModel?.() === model);
  function forgetClasses(keep = MAX_CLASSES) {
    for (const [key, model] of classModels) {
      if (classModels.size <= keep) break;
      if (shown(model)) continue;
      classModels.delete(key);
      originals.delete(key);
      model.dispose();
    }
  }
  async function loadModel(client, uri) {
    const parsed = monaco.Uri.parse(uri);
    const key = parsed.toString();
    originals.set(key, originals.get(uri) || uri);
    const live = monaco.editor.getModel(parsed);
    if (live) return live;
    const text = await client.request('java/classFileContents', { uri: originals.get(key) });
    if (typeof text !== 'string') return null;
    if (monaco.editor.getModel(parsed)) return monaco.editor.getModel(parsed);
    const model = monaco.editor.createModel(text, 'java', parsed);
    classModels.set(key, model);
    forgetClasses();
    return model;
  }
  ide.on('projectClosed', () => forgetClasses(0));
  const classTitle = (uri) => decodeURIComponent(String(uri).split('?')[0].split('/').pop() || 'class');
  async function openUri(client, uri, range) {
    const model = await loadModel(client, uri);
    if (!model) return;
    const tab = ide.openCustomTab({
      id: `jdt:${model.uri.toString()}`, title: classTitle(uri),
      mount(host, t) {
        host.classList.add('java-class-view');
        t.editor = ide.createEditor(host, { model, readOnly: true, automaticLayout: true });
      },
      onClose: (t) => { t.editor?.dispose(); },
    });
    if (range && tab.editor) {
      const pos = { lineNumber: range.start.line + 1, column: range.start.character + 1 };
      tab.editor.setPosition(pos);
      tab.editor.revealPositionInCenter(pos);
      tab.editor.focus();
    }
  }

  // JDT LS's postfix templates (`helper.cast`, `.var`, `.for`) replace `expr.` itself, so right after a dot Monaco
  // scores them above every member (they match the typed `expr.`, the members match nothing yet). IntelliJ IDEA lists
  // them last: here the template replaces only the word after the dot and an additional edit removes `expr.`, so they
  // filter by their own name and sort by JDT LS's sortText, after the members.
  function postfixLast(s, it, { position, wordRange }) {
    const r = it.kind === 15 && it.textEdit?.range;
    if (!r || r.start.line !== position.lineNumber - 1 || r.end.line !== r.start.line || r.start.character + 1 >= wordRange.startColumn) return s;
    const ownEdits = [{ range: new monaco.Range(position.lineNumber, r.start.character + 1, position.lineNumber, wordRange.startColumn), text: '' }];
    return { ...s, range: wordRange, filterText: it.label, ownEdits, additionalTextEdits: [...(s.additionalTextEdits || []), ...ownEdits] };
  }

  // ---------- the client ----------
  // Main refuses to start it for these, with a code.
  const REFUSED = {
    untrusted: () => ({ state: 'safe', message: tr('Safe Mode: Java code insight starts once the project is trusted') }),
    missing: () => { offer('missing'); return { state: 'missing', message: tr('Eclipse JDT Language Server is not installed. Click to download it.') }; },
    nojdk: () => { offer('nojdk'); return { state: 'nojdk', message: tr('No JDK 21 or later to run the Java language server. Click to download one.') }; },
  };
  const java = ide.lsp.createClient({
    id: 'java', language: 'java', match: /\.java$/i, channel: 'java-lsp', source: 'java', serverName: 'JDT LS',
    statusId: 'javaLspStatus', statusOrder: 21, hideWhenOff: true, startOnOpen: true, formatting: true,
    text: {
      status: {
        off: () => tr('Java: off'), starting: () => tr('Java: starting'), ready: () => tr('Java: ready'), error: () => tr('Java: error'),
        missing: () => tr('Java: not installed'), nojdk: () => tr('Java: no JDK 21+'), safe: () => tr('Java: Safe Mode'),
      },
      server: () => tr('Java language server'),
      starting: (name) => tr('Starting the Java language server for {name}', { name }),
      failed: () => tr('The Java language server failed to start'),
      ready: (detail) => tr('Java language server ready ({jdk})', { jdk: detail }),
      exited: (code) => tr('The Java language server exited with code {code}', { code }),
      stopped: () => tr('The Java language server stopped'),
      error: (message) => tr('Java language server error: {message}', { message }),
      stoppedTitle: () => tr('Java language server stopped'),
      crashed: (count, minutes) => tr('The Java language server crashed {count} times in the last {minutes} minutes and is not restarted automatically.', { count, minutes }),
      notReady: () => tr('Cannot search for usages: the Java language server is not ready'),
    },
    async start(client) {
      if (!(await isJavaProject(client))) return null;
      if (ide.trusted === false) return REFUSED.untrusted();
      const { project, runner } = await runtimes();
      if (!runner) return REFUSED.nojdk();
      const jdk = project ? { home: project.home, version: project.version } : null;
      return { key: `${runner.home}|${jdk?.home}`, args: [{ java: runner.home, jdk }], detail: ide.toolchains.label(runner) };
    },
    failed: (answer) => REFUSED[answer.code]?.() || null,
    restartOn: ['projectOpened', 'toolchainsChanged'],
    // Importing a Maven or Gradle project (its dependencies downloaded first) can take minutes: the item shows how far.
    onProgress(client, p) {
      const label = p.percent == null ? null : tr('Java: starting {percent}%', { percent: p.percent });
      client.setStatus('starting', [tr('Starting the Java language server for {name}', { name: basename(ide.root || '') }), p.detail].filter(Boolean).join(' · '), label);
    },
    onStatusClick(client, state) {
      if (state === 'missing') return install('missing');
      if (state === 'nojdk') return install('nojdk');
      if (state === 'safe') return ide.trustProject?.();
      return client.restart();
    },
    completion: { triggerCharacters: ['.', '@', '#'], adapt: postfixLast },
    openUri,
    loadModel,
  });

  ide.on('settingsChanged', (key) => { if (ide.root && key === `toolchains.jdk:${ide.root}`) java.ensureServer(); });
  ide.registerAction({ id: 'Java.RestartLanguageServer', title: tr('Restart Java Language Server'), run: () => java.restart() });
})();
