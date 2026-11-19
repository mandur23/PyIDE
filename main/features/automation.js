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
const CONTAINER = /^[a-f0-9]{12,64}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][\w.-]*$/;
const IMAGE = /^(sha256:)?[a-f0-9]{12,64}$/;
const VOLUME = /^[A-Za-z0-9][\w.-]*$/;
// The last lines of a container's output, each cut to what a tool window shows.
const lastLines = (text, n) => text.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter((l) => l.trim()).slice(-n).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n');
const jsonLines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
// What a compose file's button runs. `service` narrows the ones that take one.
const ACTIONS = {
  // --wait: the command ends once every service runs (and is healthy, where it has a health check), and fails when one
  // does not come up, so a start that did not work says so instead of ending at once with a container that then exits.
  up: { args: ['up', '-d', '--wait'], service: true },
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
      // Where each port is published: 127.0.0.1 for this computer alone, 0.0.0.0 for the network too (the Ports window).
      const published = row ? (row.Publishers || []).filter((p) => p.PublishedPort && String(p.Protocol || 'tcp') === 'tcp' && !String(p.URL || '').includes(':'))
        .map((p) => ({ port: Number(p.PublishedPort), address: String(p.URL || '127.0.0.1') })).filter((p, i, all) => all.findIndex((o) => o.port === p.port) === i) : [];
      return { name, state: row ? String(row.State || '') : '', status: row ? String(row.Status || '') : '', health: row ? String(row.Health || '') : '', ports, published,
        container: row ? String(row.Name || '') : '', image: row ? String(row.Image || '') : '', exit: row && String(row.State) === 'exited' ? Number(row.ExitCode ?? 0) : null };
    });
    // A service that ended by itself with an error says why: the last lines it wrote (three services at most a reading).
    await Promise.all(services.filter((s) => s.exit && CONTAINER_NAME.test(s.container)).slice(0, 3).map(async (s) => {
      const logs = await ask(argv, ['logs', '--tail', '6', s.container], cwd, 8000);
      s.why = lastLines(`${logs.out}\n${logs.err}`, 6);
    }));
    return { services };
  });

  // Every container of this computer's Docker, as Docker Desktop lists them: -> {containers: [{id, name, image, state,
  // status, ports, project}]} | {error}. project: the compose project a container belongs to, or ''.
  ipcMain.handle('automation:containers', async () => {
    const argv = dockerArgv();
    if (!argv) return { error: 'Docker was not found.' };
    const r = await ask(argv, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    if (r.code !== 0) return { error: reason(r.err) || `docker ps ended with code ${r.code}` };
    const containers = [];
    for (const line of r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      let c;
      try { c = JSON.parse(line); } catch { continue; }
      const id = String(c.ID || '');
      if (!CONTAINER.test(id)) continue;
      // "0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp, 9300/tcp": the published ones, once each
      const ports = [...new Set([...String(c.Ports || '').matchAll(/:(\d+)->/g)].map((m) => m[1]))].join(', ');
      const project = /(?:^|,)com\.docker\.compose\.project=([^,]*)/.exec(String(c.Labels || ''))?.[1] || '';
      const exit = String(c.State) === 'exited' ? Number(/Exited \((\d+)\)/.exec(String(c.Status || ''))?.[1] ?? 0) : null;
      containers.push({ id, name: String(c.Names || '').split(',')[0], image: String(c.Image || ''), state: String(c.State || ''), status: String(c.Status || ''), ports, project, exit });
    }
    containers.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    return { containers };
  });

  // What the running containers use now: -> {name: {cpu: '0.45%', memory: '393.1MiB'}}
  ipcMain.handle('automation:stats', async () => {
    const argv = dockerArgv();
    if (!argv) return {};
    const r = await ask(argv, ['stats', '--no-stream', '--format', '{{json .}}'], undefined, 12000);
    if (r.code !== 0) return {};
    return Object.fromEntries(jsonLines(r.out).filter((s) => s.Name).map((s) => [String(s.Name), { cpu: String(s.CPUPerc || ''), memory: String(s.MemUsage || '').split('/')[0].trim() }]));
  });

  // The images and the volumes of this computer's Docker: -> {images: [{id, name, size, created, used}], volumes: [{name}]}
  ipcMain.handle('automation:storage', async () => {
    const argv = dockerArgv();
    if (!argv) return { images: [], volumes: [] };
    const [im, vo] = await Promise.all([ask(argv, ['images', '--format', '{{json .}}']), ask(argv, ['volume', 'ls', '--format', '{{json .}}'])]);
    const images = jsonLines(im.out).filter((i) => IMAGE.test(String(i.ID || ''))).map((i) => ({ id: String(i.ID), name: i.Repository === '<none>' ? String(i.ID) : `${i.Repository}:${i.Tag}`, size: String(i.Size || ''), created: String(i.CreatedSince || ''), used: Number(i.Containers) > 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const volumes = jsonLines(vo.out).filter((v) => VOLUME.test(String(v.Name || ''))).map((v) => ({ name: String(v.Name) })).sort((a, b) => a.name.localeCompare(b.name));
    return { images, volumes };
  });

  // Removes an image or a volume nothing uses (docker refuses one in use, and says so). spec: {root, kind, id}
  ipcMain.handle('automation:remove', (_e, spec = {}) => {
    const { root, kind, id } = spec;
    const args = kind === 'image' && typeof id === 'string' && IMAGE.test(id) ? ['rmi', id] : kind === 'volume' && typeof id === 'string' && VOLUME.test(id) ? ['volume', 'rm', id] : null;
    if (!args) throw expected(`${id} is not an image or a volume`);
    if (typeof root === 'string' && path.isAbsolute(root) && !isTrusted(root)) throw expected('The project is not trusted (Safe Mode)');
    const argv = dockerArgv();
    if (!argv) throw expected('Docker was not found. Install Docker Desktop, or start Nano Studio again if it was installed just now.');
    const pid = startProcess(argv[0], [...argv.slice(1), ...args], { windowsHide: true, encoding: 'utf8' });
    return { id: pid, command: shown(args) };
  });

  // One container, by its id: start, stop, restart, its logs, or remove it (stopped first). spec: {root, id, action}
  ipcMain.handle('automation:container', (_e, spec = {}) => {
    const { root, id, action } = spec;
    const args = { start: ['start', id], stop: ['stop', id], restart: ['restart', id], logs: ['logs', '-f', '--tail', '200', id], rm: ['rm', '-f', id] }[action];
    if (!args) throw new Error(`Unknown container action ${action}`);
    if (typeof id !== 'string' || !CONTAINER.test(id)) throw expected(`${id} is not a container id`);
    if (typeof root === 'string' && path.isAbsolute(root) && !isTrusted(root)) throw expected('The project is not trusted (Safe Mode)');
    const argv = dockerArgv();
    if (!argv) throw expected('Docker was not found. Install Docker Desktop, or start Nano Studio again if it was installed just now.');
    const pid = startProcess(argv[0], [...argv.slice(1), ...args], { windowsHide: true, encoding: 'utf8' });
    return { id: pid, command: shown(args) };
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
