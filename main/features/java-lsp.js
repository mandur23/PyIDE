// Eclipse JDT Language Server for Java (main/lsp-server.js runs it, under the java-lsp:* channels). It runs on a JDK 21
// or later, imports Maven and Gradle projects itself (downloading their dependencies), and treats a folder without a
// build file as a plain project with `src` (or the marked source roots) as its sources. Its workspace (the imported
// projects, indexes) lives per project under <userData>/java-lsp, never in the project.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const projectRoots = require('../project-roots');
const { isTrusted } = require('../trust');
const { createToolchains } = require('../installer/toolchains');
const { serve } = require('../lsp-server');

const expected = (message, code) => Object.assign(new Error(message), { code, expected: true });
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// JDT LS names a JDK by its execution environment: JavaSE-1.8, JavaSE-11 … JavaSE-25.
function executionEnvironment(version) {
  const m = /^(?:1\.(\d+)|(\d+))/.exec(String(version || ''));
  if (!m) return null;
  return m[1] ? `JavaSE-1.${m[1]}` : `JavaSE-${m[2]}`;
}

// The plain project's source folders: the marked source and test roots (Mark Directory As), else src.
function sourcePaths(root) {
  const r = projectRoots.rootsOf(root);
  const marked = [...r.sources, ...r.tests];
  if (marked.length) return marked;
  return isDir(path.join(root, 'src')) ? ['src'] : [];
}

function settingsFor(root, jdk) {
  const ee = jdk && executionEnvironment(jdk.version);
  return {
    java: {
      configuration: {
        runtimes: ee ? [{ name: ee, path: jdk.home, default: true }] : [],
        updateBuildConfiguration: 'automatic',
      },
      project: { sourcePaths: sourcePaths(root), referencedLibraries: ['lib/**/*.jar'] },
      import: {
        maven: { enabled: true },
        gradle: { enabled: true, ...(jdk ? { java: { home: jdk.home } } : {}) },
        exclusions: ['**/node_modules/**', '**/.metadata/**', '**/archetype-resources/**', '**/META-INF/maven/**'],
      },
      format: { enabled: true, insertSpaces: true, tabSize: 4 },
      signatureHelp: { enabled: true, description: { enabled: true } },
      completion: { enabled: true },
      errors: { incompleteClasspath: { severity: 'warning' } },
      autobuild: { enabled: true },
    },
  };
}

// 'java.format.tabSize' -> settings.java.format.tabSize
const lookup = (settings, section) => String(section || '').split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), settings);

// language/status 'Starting' messages: "27% Starting Java Language Server - Importing project demo". The percentage
// runs past 100 near the end ("1100%").
function startingProgress(message) {
  const m = /^(\d+)% Starting Java Language Server(?: - (.*))?$/.exec(message || '');
  return m ? { percent: Math.min(100, Number(m[1])), detail: m[2] || '' } : { percent: null, detail: message || '' };
}

function jdtlsSpec({ home, root, java, jdk, dataDir, send }) {
  const launcher = fs.readdirSync(path.join(home, 'plugins')).find((n) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(n));
  if (!launcher) throw expected(`The Eclipse JDT Language Server in ${home} is incomplete`, 'missing');
  const settings = settingsFor(root, jdk);
  return {
    name: 'JDT LS',
    processName: 'Eclipse JDT Language Server',
    shutdownMs: 3000,
    exclusiveData: true,
    spawn: () => ({
      cmd: path.join(java, 'bin', 'java.exe'),
      args: [
        '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product',
        // The install folder stays read-only (shared by every project); each project's OSGi state goes to its data folder.
        '-Dosgi.checkConfiguration=true', `-Dosgi.sharedConfiguration.area=${path.join(home, 'config_win')}`,
        '-Dosgi.sharedConfiguration.area.readOnly=true', '-Dosgi.configuration.cascaded=true',
        // Eclipse's .project, .classpath and .settings go to the workspace, not into the user's Maven or Gradle project.
        '-Djava.import.generatesMetadataFilesAtProjectRoot=false',
        '-Dfile.encoding=UTF-8', '-Dsun.zip.disableMemoryMapping=true',
        // JDK 24 and later limit XML entity sizes, which some Maven metadata exceeds.
        '-Djdk.xml.maxGeneralEntitySizeLimit=0', '-Djdk.xml.totalEntitySizeLimit=0',
        '-Xms100m', '-Xmx1G', '-XX:+UseParallelGC', '-XX:GCTimeRatio=4', '-XX:AdaptiveSizePolicyWeight=90',
        '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
        '-jar', path.join(home, 'plugins', launcher),
        '-configuration', path.join(dataDir, 'config'),
        '-data', path.join(dataDir, 'workspace'),
      ],
      env: { ...process.env, JAVA_HOME: jdk?.home || java },
    }),
    initializationOptions: {
      workspaceFolders: [pathToFileURL(root).href],
      settings,
      extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: false },
    },
    settingsFor: (section) => lookup(settings, section),
    // New source roots (Mark Directory As) of a plain project, read again when they change.
    settings: () => Object.assign(settings, settingsFor(root, jdk)),
    watched: /\.(java|jar)$|(^|[\\/])(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/i,
    watchIgnored: /[\\/](target|build|out|bin|\.gradle|\.settings)([\\/]|$)/i,
    // Ready once the projects are imported (language/status Started, then ServiceReady; Error when an import failed,
    // after which it still answers for what it could import); the import of a Maven or Gradle project downloads its
    // dependencies first, which can take minutes, so its progress goes to the renderer.
    whenReady: (server) => new Promise((resolve, reject) => {
      server.serviceReady = resolve;
      server.proc.once('exit', (code) => reject(new Error(`JDT LS exited with code ${code}`)));
    }),
    onNotification(server, method, params) {
      if (method !== 'language/status' || server.stopping) return;
      if (['Started', 'ServiceReady', 'Error'].includes(params?.type)) server.serviceReady?.();
      else if (params?.type === 'Starting') send('java-lsp:progress', { gen: server.gen, ...startingProgress(params.message) });
    },
  };
}

exports.register = (ctx) => {
  const toolchains = createToolchains();
  const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // One folder per project: its name (for people looking) and a hash of its path.
  const dataDirOf = (root) => {
    const key = path.resolve(root).toLowerCase();
    const name = path.basename(key).replace(/[^\w.-]/g, '_').slice(0, 40);
    return path.join(ctx.app.getPath('userData'), 'java-lsp', `${name}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`);
  };

  // java-lsp:start(root, {java, jdk}): java is the home of the JDK (21 or later) that runs the server; jdk {home,
  // version} the project's JDK, which the project compiles against (it may be older), or null.
  // Only a JDK found on this computer (toolchains:list) runs, never a path the renderer made up.
  const { current } = serve(ctx, 'java-lsp', async (root, opts = {}) => {
    if (!isTrusted(root)) throw expected('The project is not trusted', 'untrusted');
    const server = toolchains.status('jdtls');
    if (!server.installed) throw expected('The Eclipse JDT Language Server is not installed', 'missing');
    const jdks = await toolchains.detect('jdk');
    const found = (home) => (typeof home === 'string' ? jdks.find((t) => sameDir(t.home, home)) : null);
    const runner = found(opts.java);
    if (!runner || parseInt(String(runner.version).replace(/^1\./, ''), 10) < 21 || !isFile(path.join(runner.home, 'bin', 'java.exe'))) {
      throw expected('No JDK 21 or later', 'nojdk');
    }
    const project = found(opts.jdk?.home);
    const dataDir = dataDirOf(root);
    fs.mkdirSync(dataDir, { recursive: true });
    return jdtlsSpec({ home: server.home, root, java: runner.home, jdk: project && { home: project.home, version: project.version }, dataDir, send: ctx.send });
  });
  projectRoots.onChange((root) => {
    const s = current();
    if (s?.initialized && !s.dead && sameDir(root, s.root)) s.configurationChanged();
  });
};

Object.assign(exports, { executionEnvironment, startingProgress });
