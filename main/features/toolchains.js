// Java and C/C++: lists the JDKs and C/C++ compilers (built-in and on this computer) and starts their tools (javac,
// java, gcc, g++, a built program) with the toolchain first on PATH, streamed through proc:data / proc:exit.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolchains } = require('../installer/toolchains');
const { isTrusted } = require('../trust');

const TOOL = /^[\w+.-]+$/;
// What New Project runs in the background so the first run starts quickly, like IntelliJ's import. Maven resolves the
// dependencies and the plugins; Gradle's dependencies task reads only the metadata, so the classes are compiled, which
// downloads the jars too. -B leaves out Maven's transfer progress lines.
const SYNC_GOALS = { maven: '-B dependency:go-offline', gradle: 'classes testClasses' };

// -> {code, out}; a probe that hangs (a broken compiler waiting on something) counts as failed after 10 seconds, and
// one Windows refuses to start (not a program: spawn throws UNKNOWN) right away.
const probe = (cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout}${stderr}` });
    });
  } catch (err) {
    resolve({ code: -1, out: err.message });
  }
});

exports.register = ({ ipcMain, startProcess, procs }) => {
  const toolchains = createToolchains({ run: probe });
  let argfiles = 0;

  ipcMain.handle('toolchains:list', (_e, kind) => toolchains.detect(kind));

  // A Maven or Gradle run configuration: {tool: 'maven' | 'gradle', goals: 'spring-boot:run', cwd, env, jdk?: {home}}.
  // The project's wrapper (mvnw.cmd, gradlew.bat) wins over mvn or gradle on PATH; it is named with .\ because cmd.exe
  // skips the current folder when NoDefaultCurrentDirectoryInExePath is set. Goals are words, so cmd.exe gets no syntax.
  // sync: true downloads the build tool and the dependencies instead (SYNC_GOALS), and only in a trusted project, since
  // nobody asked for it. debugPort: the application's JVM listens there for the debugger (JDWP, suspended until it
  // attaches): Maven's spring-boot:run gets it as -Dspring-boot.run.jvmArguments (the plugin forks that JVM), other
  // Maven goals through MAVEN_OPTS (exec:java runs in Maven's own JVM), and Gradle's JavaExec tasks (bootRun, run)
  // through an init script.
  let debugScripts = 0;
  ipcMain.handle('toolchains:build', (_e, spec = {}) => {
    const { tool, cwd, env = {}, jdk, sync, debugPort } = spec;
    if (!['maven', 'gradle'].includes(tool)) throw new Error(`Unknown build tool ${tool}`);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('No working directory');
    if (sync && !isTrusted(cwd)) throw Object.assign(new Error('The project is not trusted (Safe Mode)'), { expected: true });
    const goals = sync ? SYNC_GOALS[tool] : spec.goals || '';
    if (!/^[\w:.=,@/+-]+( [\w:.=,@/+-]+)*$/.test(goals.trim())) throw Object.assign(new Error(`Goals or tasks may hold letters, digits and : . = , @ / + - only: ${goals}`), { expected: true });
    const wrapper = tool === 'maven' ? 'mvnw.cmd' : 'gradlew.bat';
    const program = fs.existsSync(path.join(cwd, wrapper)) ? `.\\${wrapper}` : tool === 'maven' ? 'mvn' : 'gradle';
    const extra = jdk?.home && path.isAbsolute(jdk.home) ? { JAVA_HOME: jdk.home } : {};
    let command = `${program} ${goals.trim()}`;
    let initScript = null;
    if (debugPort !== undefined) {
      if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) throw new Error(`Bad debug port ${debugPort}`);
      const agent = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${debugPort}`;
      if (tool === 'gradle') {
        initScript = path.join(os.tmpdir(), `pyide-debug-${process.pid}-${++debugScripts}.gradle`);
        fs.writeFileSync(initScript, `allprojects {\n    tasks.withType(JavaExec).configureEach { jvmArgs '${agent}' }\n}\n`);
        command += ` --init-script "${initScript}"`;
      } else if (/(^| )spring-boot:run( |$)/.test(goals.trim())) command += ` "-Dspring-boot.run.jvmArguments=${agent}"`;
      else extra.MAVEN_OPTS = `${env.MAVEN_OPTS || process.env.MAVEN_OPTS || ''} ${agent}`.trim();
    }
    // Nothing downloaded yet (the wrapper's build tool, the dependency cache): the first run takes minutes.
    const home = process.env.PYIDE_BUILD_HOME || os.homedir();
    const cache = tool === 'maven' ? [path.join(home, '.m2', 'repository'), ...(program.startsWith('.') ? [path.join(home, '.m2', 'wrapper', 'dists')] : [])]
      : [path.join(home, '.gradle', 'caches'), ...(program.startsWith('.') ? [path.join(home, '.gradle', 'wrapper', 'dists')] : [])];
    const firstRun = cache.some((d) => !fs.existsSync(d));
    const id = startProcess('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      cwd, windowsHide: true, windowsVerbatimArguments: true, env: { ...env, ...extra },
      // Java writes piped output in the native code page (CP949 on Korean Windows).
      encoding: 'cp949',
    });
    if (initScript) {
      const child = procs.get(id);
      if (child) child.once('exit', () => fs.rm(initScript, { force: true }, () => {}));
      else fs.rm(initScript, { force: true }, () => {});
    }
    return { id, command, firstRun };
  });

  // spec: {toolchain: {kind, home, bin}, cmd: a tool in its bin folder ('javac') or an absolute path (a built
  // program), args, cwd, env, argfile?: arguments written to an @file (javac and gcc read them) so a long source list
  // fits on the command line, makeDirs?: folders to create first (gcc's -o folder)}.
  ipcMain.handle('toolchains:start', (_e, spec = {}) => {
    const { toolchain = {}, cmd = '', args = [], cwd, env = {}, argfile, makeDirs = [] } = spec;
    if (typeof toolchain.bin !== 'string' || !path.isAbsolute(toolchain.bin)) throw new Error('No toolchain');
    const program = TOOL.test(cmd) ? path.join(toolchain.bin, `${cmd}.exe`) : cmd;
    if (!path.isAbsolute(program)) throw new Error(`Bad program ${cmd}`);
    for (const d of makeDirs) if (typeof d === 'string' && path.isAbsolute(d)) fs.mkdirSync(d, { recursive: true });
    const extra = {};
    if (toolchain.kind === 'jdk' && toolchain.home) extra.JAVA_HOME = toolchain.home;
    const argv = [...args];
    let file = null;
    if (Array.isArray(argfile) && argfile.length) {
      file = path.join(os.tmpdir(), `pyide-args-${process.pid}-${++argfiles}.txt`);
      // Forward slashes and quotes: both tools treat a backslash inside quotes as an escape.
      fs.writeFileSync(file, argfile.map((a) => `"${String(a).replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join('\n'));
      argv.push(`@${file}`);
    }
    // process.env spells it Path; another key spelled PATH would leave two in the child's environment.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const id = startProcess(program, argv, {
      cwd, windowsHide: true,
      env: { ...env, ...extra, [pathKey]: `${toolchain.bin};${process.env[pathKey] || ''}` },
    });
    if (file) {
      const child = procs.get(id);
      if (child) child.once('exit', () => fs.rm(file, { force: true }, () => {}));
      else fs.rm(file, { force: true }, () => {});
    }
    return id;
  });
};
