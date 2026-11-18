// The Automation tool window's main side: what the project can run besides its code (Docker Compose files, Dockerfiles,
// a Gradle or Maven build), Docker's state, a compose file's services, and the docker commands themselves, which run
// as processes the Run tool window shows. Docker is found on PATH or where Docker Desktop installs it: an app started
// before Docker was installed has no docker on its PATH. PYIDE_DOCKER (tests): a JSON array, the program and its first
// arguments run in place of docker; any other value finds none.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isTrusted } = require('../trust');

const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const DOCKERFILE = /^(Dockerfile(\.[\w-]+)?|[\w-]+\.Dockerfile)$/i;
const SKIP = new Set(['node_modules', '.git', '.gradle', '.idea', '.venv', 'venv', 'build', 'target', 'dist', 'out', 'bin', '__pycache__']);
const SERVICE = /^[A-Za-z0-9][\w.-]*$/;
// What a compose file's button runs. `service` narrows the ones that take one.
const ACTIONS = {
  up: { args: ['up', '-d'], service: true },
  build: { args: ['build'], service: true },
  down: { args: ['down'] },
  logs: { args: ['logs', '-f', '--tail', '200'], service: true },
  start: { args: ['start'], service: true },
  stop: { args: ['stop'], service: true },
  restart: { args: ['restart'], service: true },
};

const expected = (message) => Object.assign(new Error(message), { expected: true });
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// -> [program, ...first arguments] or null
function dockerArgv() {
  const stand = process.env.PYIDE_DOCKER;
  if (stand !== undefined) {
    try { const a = JSON.parse(stand); return Array.isArray(a) && a.length && a.every((x) => typeof x === 'string') ? a : null; } catch { return null; }
  }
  const dirs = String(process.env.PATH || process.env.Path || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => path.isAbsolute(d));
  for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Docker', 'Docker'),
    process.env.ProgramW6432 && path.join(process.env.ProgramW6432, 'Docker', 'Docker')]) {
    if (base) dirs.push(path.join(base, 'resources', 'bin'));
  }
  for (const d of dirs) {
    const exe = path.join(d, 'docker.exe');
    if (isFile(exe)) return [exe];
  }
  return null;
}

// docker's answer to a short question: -> {code, out, err}
function ask(argv, args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(argv[0], [...argv.slice(1), ...args], { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, out, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(stderr || (err && !out ? err.message : '') || '') });
    });
  });
}

// The files of `root` a tool window lists, two folders deep: compose files, Dockerfiles, and a build at the root.
function detect(root) {
  const compose = [];
  const dockerfiles = [];
  const walk = (dir, depth) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(root, abs);
      if (COMPOSE.test(e.name)) compose.push({ file: abs, rel });
      else if (DOCKERFILE.test(e.name)) dockerfiles.push({ file: abs, rel, image: imageName(root, abs) });
    }
  };
  walk(root, 0);
  compose.sort((a, b) => a.rel.split(path.sep).length - b.rel.split(path.sep).length || a.rel.localeCompare(b.rel));
  return { compose, dockerfiles, builds: builds(root) };
}

// The build tools of the project's root and the tasks worth a button: the ones every build has, and what its plugins add.
function builds(root) {
  const read = (name) => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return null; } };
  const out = [];
  const gradle = read('build.gradle') ?? read('build.gradle.kts');
  if (gradle !== null || isFile(path.join(root, 'settings.gradle')) || isFile(path.join(root, 'settings.gradle.kts'))) {
    const text = gradle || '';
    const tasks = ['build', 'test', 'clean'];
    if (/org\.springframework\.boot/.test(text)) tasks.unshift('bootRun', 'bootJar');
    else if (/\bapplication\b/.test(text)) tasks.unshift('run');
    out.push({ tool: 'gradle', title: 'Gradle', wrapper: isFile(path.join(root, 'gradlew.bat')), tasks, java: javaOf(text) });
  }
  const pom = read('pom.xml');
  if (pom !== null) {
    const tasks = ['compile', 'test', 'package', 'clean'];
    if (/spring-boot-maven-plugin/.test(pom)) tasks.unshift('spring-boot:run');
    out.push({ tool: 'maven', title: 'Maven', wrapper: isFile(path.join(root, 'mvnw.cmd')), tasks, java: javaOf(pom) });
  }
  return out;
}

// The Java a build asks for: Gradle's toolchain or source level, Maven's java.version or compiler release; 21 when it
// names none.
function javaOf(text) {
  const m = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(text) || /(?:sourceCompatibility|targetCompatibility)\s*=?\s*(?:JavaVersion\.VERSION_|['"]?)(\d+)/.exec(text)
    || /<java\.version>\s*(\d+)/.exec(text) || /<maven\.compiler\.(?:release|source)>\s*(\d+)/.exec(text);
  const n = m ? Number(m[1]) : 21;
  return n >= 8 && n <= 99 ? n : 21;
}
// The port a Spring Boot run listens on: server.port of its application properties, else 8080.
function springPort(root) {
  for (const f of ['src/main/resources/application.properties', 'src/main/resources/application.yml', 'src/main/resources/application.yaml']) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const m = /^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m.exec(text) || /^server:\s*(?:\r?\n[ \t]+.*)*?\r?\n[ \t]+port:\s*(\d{2,5})\s*$/m.exec(text);
    if (m) return Number(m[1]);
  }
  return 8080;
}
// A name docker takes for an image and a container, from the project's folder (and the Dockerfile's, below the root).
const imageName = (root, file) => `nano-${[path.basename(root), ...path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)].join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}`;
const shown = (args) => `docker ${args.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ')}`;

// A compose file of the project: inside it, and named as one.
function composeFile(root, file) {
  if (typeof root !== 'string' || typeof file !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(file)) throw new Error('No compose file');
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !COMPOSE.test(path.basename(file)) || !isFile(file)) throw expected(`${file} is not a compose file of this project`);
  return file;
}

// The last lines docker wrote before it gave up, without its "time=... level=warning" noise.
const reason = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^time=.*level=(warning|info)/.test(l)).slice(-4).join('\n');

exports.detect = detect;
exports.register = ({ ipcMain, startProcess }) => {
  ipcMain.handle('automation:detect', (_e, root) => (typeof root === 'string' && path.isAbsolute(root) ? detect(root) : { compose: [], dockerfiles: [], builds: [] }));

  // -> {found: false} | {found: true, exe, client, server} | {found: true, exe, client, error} (the engine is not running)
  ipcMain.handle('automation:docker', async () => {
    const argv = dockerArgv();
    if (!argv) return { found: false };
    const r = await ask(argv, ['version', '--format', '{{.Client.Version}}|{{if .Server}}{{.Server.Version}}{{end}}'], undefined, 10000);
    const [client, server] = r.out.trim().split('\n').pop().split('|');
    if (r.code === 0 && server) return { found: true, exe: argv[0], client, server };
    return { found: true, exe: argv[0], client: client || '', error: reason(r.err) || 'The Docker engine did not answer.' };
  });

  // -> {services: [{name, state, status, ports}]} | {error}. state: running, exited, created, paused ... or '' for a
  // service without a container.
  ipcMain.handle('automation:services', async (_e, root, file) => {
    const argv = dockerArgv();
    if (!argv) return { error: 'Docker was not found.' };
    const f = composeFile(root, file);
    if (!isTrusted(root)) return { error: 'The project is not trusted (Safe Mode).' };
    const cwd = path.dirname(f);
    const names = await ask(argv, ['compose', '-f', f, 'config', '--services'], cwd);
    if (names.code !== 0) return { error: reason(names.err) || `docker compose config ended with code ${names.code}` };
    const ps = await ask(argv, ['compose', '-f', f, 'ps', '-a', '--format', 'json'], cwd);
    // One JSON object a line (Compose 2.21 on), or one array.
    const rows = [];
    for (const line of ps.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      try { const v = JSON.parse(line); rows.push(...(Array.isArray(v) ? v : [v])); } catch { /* not a row */ }
    }
    const services = names.out.split(/\r?\n/).map((l) => l.trim()).filter((n) => SERVICE.test(n)).sort().map((name) => {
      const row = rows.find((r) => r.Service === name);
      const ports = row ? [...new Set((row.Publishers || []).filter((p) => p.PublishedPort).map((p) => `${p.PublishedPort}`))].join(', ') : '';
      return { name, state: row ? String(row.State || '') : '', status: row ? String(row.Status || '') : '', health: row ? String(row.Health || '') : '', ports };
    });
    return { services };
  });

  // Starts docker compose <action> as a process of the Run tool window: -> {id, command}
  ipcMain.handle('automation:compose', (_e, spec = {}) => {
    const { root, action, service } = spec;
    const a = ACTIONS[action];
    if (!a) throw new Error(`Unknown compose action ${action}`);
    const f = composeFile(root, spec.file);
    if (!isTrusted(root)) throw expected('The project is not trusted (Safe Mode)');
    if (service && (!a.service || !SERVICE.test(service))) throw expected(`${service} is not a service name`);
    const argv = dockerArgv();
    if (!argv) throw expected('Docker was not found. Install Docker Desktop, or start Nano Studio again if it was installed just now.');
    const args = ['compose', '-f', f, ...a.args, ...(service ? [service] : [])];
    const id = startProcess(argv[0], [...argv.slice(1), ...args], { cwd: path.dirname(f), windowsHide: true, encoding: 'utf8' });
    return { id, command: shown(args) };
  });

  // A build task inside a container of the JDK the build asks for, the project mounted at /workspace: no JDK on the
  // computer is used. The build tool's downloads are kept in a volume, so the second run does not fetch them again.
  // A wrapper is read with its line endings fixed (a gradlew checked out on Windows ends its lines with CR LF, which
  // sh refuses) and runs from the project's folder; without one the build tool's own image runs it.
  // spec: {root, tool: 'gradle' | 'maven', goals} -> {id, command, image}
  ipcMain.handle('automation:buildInContainer', (_e, spec = {}) => {
    const { root, tool } = spec;
    if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('No project folder');
    if (!['gradle', 'maven'].includes(tool)) throw new Error(`Unknown build tool ${tool}`);
    if (!isTrusted(root)) throw expected('The project is not trusted (Safe Mode)');
    const goals = String(spec.goals || '').trim();
    if (!/^[\w:.=,@/+-]+( [\w:.=,@/+-]+)*$/.test(goals)) throw expected(`Goals or tasks may hold letters, digits and : . = , @ / + - only: ${goals}`);
    const argv = dockerArgv();
    if (!argv) throw expected('Docker was not found. Install Docker Desktop, or start Nano Studio again if it was installed just now.');
    const build = builds(root).find((b) => b.tool === tool);
    if (!build) throw expected(`This project has no ${tool} build`);
    const wrapper = tool === 'gradle' ? 'gradlew' : 'mvnw';
    const hasWrapper = isFile(path.join(root, wrapper));
    const image = hasWrapper ? `eclipse-temurin:${build.java}-jdk` : tool === 'gradle' ? `gradle:jdk${build.java}` : `maven:3-eclipse-temurin-${build.java}`;
    const cache = tool === 'gradle' ? ['nano-studio-gradle:/root/.gradle'] : ['nano-studio-maven:/root/.m2'];
    const run = /(^| )(bootRun|spring-boot:run|run)( |$)/.test(goals);
    const port = run ? springPort(root) : null;
    const inner = hasWrapper ? `sed 's/\\r$//' ${wrapper} | sh -s -- ${goals}` : `${tool === 'gradle' ? 'gradle' : 'mvn'} ${goals}`;
    const args = ['run', '--rm', '-v', `${root}:/workspace`, '-w', '/workspace', ...cache.flatMap((v) => ['-v', v]),
      // A run reaches what the computer serves (a database on localhost) as host.docker.internal, and is reached on its port.
      ...(port ? ['-p', `127.0.0.1:${port}:${port}`, '-e', 'SERVER_ADDRESS=0.0.0.0'] : []),
      ...(tool === 'gradle' ? ['-e', 'GRADLE_OPTS=-Dorg.gradle.daemon=false'] : []), image, 'sh', '-c', inner];
    const id = startProcess(argv[0], [...argv.slice(1), ...args], { cwd: root, windowsHide: true, encoding: 'utf8' });
    return { id, command: shown(args), image, port };
  });

  // A Dockerfile of the project without a compose file: build its image, run a container of it (its EXPOSEd ports
  // published on the same numbers, removed when it ends), stop that container. spec: {root, file, action}
  ipcMain.handle('automation:image', (_e, spec = {}) => {
    const { root, file, action } = spec;
    if (typeof root !== 'string' || typeof file !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(file)) throw new Error('No Dockerfile');
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !DOCKERFILE.test(path.basename(file)) || !isFile(file)) throw expected(`${file} is not a Dockerfile of this project`);
    if (!isTrusted(root)) throw expected('The project is not trusted (Safe Mode)');
    const argv = dockerArgv();
    if (!argv) throw expected('Docker was not found. Install Docker Desktop, or start Nano Studio again if it was installed just now.');
    const name = imageName(root, file);
    let args;
    if (action === 'build') args = ['build', '-t', name, '-f', file, path.dirname(file)];
    else if (action === 'run') {
      const ports = [...new Set([...fs.readFileSync(file, 'utf8').matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].split(/\s+/)).map((p) => /^(\d{1,5})(\/tcp)?$/.exec(p)?.[1]).filter(Boolean))];
      args = ['run', '--rm', '--name', name, ...ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]), name];
    } else if (action === 'stop') args = ['stop', name];
    else throw new Error(`Unknown image action ${action}`);
    const id = startProcess(argv[0], [...argv.slice(1), ...args], { cwd: path.dirname(file), windowsHide: true, encoding: 'utf8' });
    return { id, command: shown(args), image: name };
  });
};
