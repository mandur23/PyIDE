// Java and C/C++ projects with real toolchains: New Project creates a plain Java project (src\Main.java, its Java
// Application configuration and JDK), Maven and Gradle layouts, a C++ and a C project; Run builds them and shows the
// program's output (Korean text included) in the Run tool window, typed input reaches the program, a single source
// file runs as `java File.java`, and compiler errors (javac, g++) land in Problems at their line and column.
// Java uses a JDK on this computer. C/C++ needs GCC: TOOLCHAINS_REAL=1 downloads the pinned w64devkit through the
// Install Manager, TOOLCHAINS_CPP_ARCHIVE=<w64devkit-x64-2.10.1.7z.exe> installs a copy of that archive from a local
// server (no network), and otherwise a GCC already on this computer is used; without one that part is skipped.
import { createHash } from 'crypto';
import http from 'http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const REAL = process.env.TOOLCHAINS_REAL === '1';
const CPP_ARCHIVE = process.env.TOOLCHAINS_CPP_ARCHIVE;
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-javacpp-'));
const where = path.join(work, 'projects');
mkdirSync(where);
const env = { PYIDE_INSTALL_ROOT: path.join(work, 'root') };

// A copy of the real w64devkit archive, served locally with its pinned size and digest.
let server = null;
if (!REAL && CPP_ARCHIVE) {
  const body = readFileSync(CPP_ARCHIVE);
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': statSync(CPP_ARCHIVE).size });
    createReadStream(CPP_ARCHIVE).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = path.join(work, 'toolchains.json');
  writeFileSync(feed, q({ cpp: { url: `http://127.0.0.1:${server.address().port}/w64devkit-x64-2.10.1.7z.exe`, size: body.length, sha256: createHash('sha256').update(body).digest('hex') } }));
  env.PYIDE_TOOLCHAINS = feed;
}

const setValue = (t, sel, value) => t.js(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${q(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
async function create(t, type, name, setup = '') {
  await t.js(`ide.runAction('NewProject')`);
  await t.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
  await t.js(`(document.querySelector('.np-type[data-type="${type}"]').click(), true)`);
  await setValue(t, '#npName', name);
  const select = type === 'java' ? '#npJdk' : '#npToolchain';
  await t.until(`document.querySelector('${select}').options.length > 0`, `${type} toolchain listed`, 30000);
  if (setup) await t.js(`(() => { ${setup}; return true; })()`);
  await t.click('#npCreate');
  await t.until(`ide.root && ide.root.toLowerCase() === ${q(path.join(where, name).toLowerCase())}`, `${name} opened`, 60000);
  return path.join(where, name);
}
// Runs the selected configuration (Shift+F10) or the one given, and waits for the program's exit line.
async function runAndWait(t, how, ms = 180000) {
  // Each run gets a new console; the previous run's text must not count.
  await t.js(`(window.__oldOut = document.querySelector('#runOut'), true)`);
  if (how === 'shift-f10') await t.press('Shift+F10');
  else await t.js(`(${how}, true)`);
  await t.until(`(() => { const o = document.querySelector('#runOut'); return !!o && o !== window.__oldOut && /Process finished with exit code|Build failed|Build cancelled/.test(o.textContent); })()`, 'run finished', ms);
  return t.js(`document.querySelector('#runOut').textContent`);
}
const forFile = (type, file) => `ide.run.runContext(ide.run.types.get('${type}').forFile(${q(file)}))`;
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

let a;
try {
  a = await launch({ fixture: 'core', port: 9771, name: 'java-cpp-projects', env });
  await a.js(`ide.settings.set('newProject.location', ${q(where)})`);

  // ---------- Java ----------
  if (REAL && !(await a.js(`ide.toolchains.list('jdk').then((l) => l.length)`))) {
    await a.js(`ide.toolchains.install('jdk')`);
  }
  const jdks = await a.js(`ide.toolchains.list('jdk').then((l) => l.map((t) => ({ id: t.id, version: t.version })))`);
  const jdk = jdks.find((j) => parseInt(j.version, 10) >= 22) || jdks[0];
  if (!jdk) {
    console.log('SKIP Java: no JDK on this computer (TOOLCHAINS_REAL=1 downloads one)');
  } else {
    const hello = await create(a, 'java', 'hello', `const s = document.querySelector('#npJdk'); s.value = ${q(jdk.id)}`);
    await a.until(`ide.activeTab()?.title === 'Main.java'`, 'Main.java opened');
    check(existsSync(path.join(hello, 'src', 'Main.java')) && readFileSync(path.join(hello, '.gitignore'), 'utf8').includes('out/') && existsSync(path.join(hello, '.git')),
      'a plain Java project has src\\Main.java, a .gitignore for out/ and a Git repository; Main.java is opened');
    const cfg = await a.js(`(() => { const c = ide.run.selected(); return c && { type: c.type, name: c.name, mainClass: c.mainClass, temporary: !!c.temporary }; })()`);
    check(cfg?.type === 'java' && cfg.mainClass === 'Main' && !cfg.temporary, `a saved Java Application configuration "Main" is selected ${q(cfg)}`);
    check(await a.js(`ide.settings.get(${q(`toolchains.jdk:${hello}`)}) === ${q(jdk.id)}`), 'the project remembers the JDK chosen in the wizard');
    let out = await runAndWait(a, 'shift-f10');
    check(out.includes('Hello and welcome!') && out.includes('i = 5') && out.includes('Process finished with exit code 0'), `Shift+F10 compiles with javac and runs Main (${q(out.slice(-160))})`);
    check(existsSync(path.join(hello, 'out', 'production', 'hello', 'Main.class')), 'classes are written to out\\production\\hello');

    write(path.join(hello, 'src', 'Greet.java'), 'import java.util.Scanner;\n\npublic class Greet {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        System.out.println("이름?");\n        String name = in.nextLine();\n        System.out.println("안녕하세요, " + name + "!");\n    }\n}\n');
    await a.js(`(${forFile('java', path.join(hello, 'src', 'Greet.java'))}, true)`);
    await a.until(`(document.querySelector('#runOut')?.textContent || '').includes('이름?')`, 'Greet prompts', 60000);
    await a.js(`document.querySelector('#runIn').focus()`);
    await a.type('Kim');
    await a.press('Enter');
    await a.until(`(document.querySelector('#runOut')?.textContent || '').includes('exit code')`, 'Greet exits');
    out = await a.js(`document.querySelector('#runOut').textContent`);
    check(out.includes('안녕하세요, Kim!'), `a class run from the project tree reads typed input, and Korean output arrives intact (${q(out.slice(-80))})`);

    write(path.join(hello, 'Script.java'), 'public class Script {\n    public static void main(String[] args) {\n        System.out.println("single file " + args.length);\n    }\n}\n');
    out = await runAndWait(a, forFile('java', path.join(hello, 'Script.java')));
    check(out.includes('single file 0') && !out.includes('javac.exe') && /Script\.java/.test(out.split('\n')[0]), `a .java file outside the source root runs as java Script.java (${q(out.split('\n')[0])})`);

    write(path.join(hello, 'src', 'Broken.java'), 'public class Broken {\n    public static void main(String[] args) {\n        int x = "text";\n    }\n}\n');
    out = await runAndWait(a, forFile('java', path.join(hello, 'src', 'Broken.java')));
    const problem = await a.js(`ide.problems.all().find((p) => p.path.toLowerCase().endsWith('broken.java'))`);
    check(out.includes('Build failed with 1 errors') && problem?.line === 3 && problem.col === 17 && /incompatible types/.test(problem.msg), `a javac error fails the build and is listed in Problems at its line and column ${q(problem)}`);
    check(await a.js(`ide.toolWindows.get('Problems').isVisible()`), 'the Problems tool window opens for compiler errors');
    await a.shot('java-problems.png');

    const mvn = await create(a, 'java', 'mvnapp', `document.querySelector('#npJdk').value = ${q(jdk.id)}; document.querySelector('input[name="npBuild"][value="maven"]').click()`);
    await a.until(`ide.activeTab()?.title === 'Main.java'`, 'maven Main.java opened');
    const pom = readFileSync(path.join(mvn, 'pom.xml'), 'utf8');
    check(pom.includes('<mainClass>org.example.Main</mainClass>') && pom.includes('exec-maven-plugin') && pom.includes(`<maven.compiler.release>${parseInt(jdk.version, 10)}</maven.compiler.release>`)
      && readFileSync(path.join(mvn, 'src', 'main', 'java', 'org', 'example', 'Main.java'), 'utf8').startsWith('package org.example;'), 'a Maven project gets a pom.xml (exec:java runs Main) and src\\main\\java\\org\\example\\Main.java');
    out = await runAndWait(a, 'shift-f10');
    check(out.includes('Hello and welcome!') && out.includes('org.example.Main'), 'its Java Application configuration builds src\\main\\java and runs org.example.Main');

    const gradle = await create(a, 'java', 'gradleapp', `document.querySelector('#npJdk').value = ${q(jdk.id)}; document.querySelector('input[name="npBuild"][value="gradle"]').click()`);
    check(readFileSync(path.join(gradle, 'build.gradle'), 'utf8').includes("mainClass = 'org.example.Main'") && readFileSync(path.join(gradle, 'settings.gradle'), 'utf8').includes("rootProject.name = 'gradleapp'"),
      'a Gradle project gets build.gradle with the application plugin and settings.gradle');
  }

  // ---------- C/C++ ----------
  if ((REAL || CPP_ARCHIVE) && !(await a.js(`ide.toolchains.list('cpp').then((l) => l.some((t) => t.builtin))`))) {
    await a.js(`ide.toolchains.install('cpp')`);
    check(await a.js(`ide.toolchains.list('cpp').then((l) => l.some((t) => t.builtin && t.compiler === 'GCC' && /^\\d+\\./.test(t.version)))`), 'the built-in w64devkit installs and its GCC answers with a version');
  }
  const compilers = await a.js(`ide.toolchains.list('cpp').then((l) => l.map((t) => t.id))`);
  if (!compilers.length) {
    console.log('SKIP C/C++: no GCC (TOOLCHAINS_REAL=1 or TOOLCHAINS_CPP_ARCHIVE installs w64devkit)');
  } else {
    const cpp = await create(a, 'cpp', 'cpphello');
    await a.until(`ide.activeTab()?.title === 'main.cpp'`, 'main.cpp opened');
    const cfg = await a.js(`(() => { const c = ide.run.selected(); return c && { type: c.type, name: c.name, flags: c.flags }; })()`);
    check(cfg?.type === 'cpp' && cfg.name === 'cpphello' && cfg.flags === '-std=c++20 -g -Wall', `a saved C/C++ Application configuration is selected ${q(cfg)}`);
    let out = await runAndWait(a, 'shift-f10');
    check(out.includes('Hello, World!') && out.includes('Process finished with exit code 0') && existsSync(path.join(cpp, 'build', 'cpphello.exe')), `Shift+F10 builds build\\cpphello.exe with g++ and runs it (${q(out.slice(-120))})`);

    await a.js(`(ide.editor.getModel().setValue(${q('#include <iostream>\n#include <string>\n\nint main() {\n    std::string line;\n    std::cout << "line?" << std::endl;\n    std::getline(std::cin, line);\n    std::cout << "got: " << line << " (" << line.size() << ")" << std::endl;\n    return 3;\n}\n')}), true)`);
    await a.press('Shift+F10');
    await a.until(`(document.querySelector('#runOut')?.textContent || '').includes('line?')`, 'program prompts', 180000);
    await a.js(`document.querySelector('#runIn').focus()`);
    await a.type('abc');
    await a.press('Enter');
    await a.until(`(document.querySelector('#runOut')?.textContent || '').includes('exit code')`, 'program exits');
    out = await a.js(`document.querySelector('#runOut').textContent`);
    check(out.includes('got: abc (3)') && out.includes('Process finished with exit code 3'), 'the edited program is saved, rebuilt, reads typed input and reports its exit code');

    await a.js(`(ide.editor.getModel().setValue(${q('#include <iostream>\n\nint main() {\n    undefined_name = 1;\n    return 0;\n}\n')}), true)`);
    out = await runAndWait(a, 'shift-f10');
    const problem = await a.js(`ide.problems.all().find((p) => p.path.toLowerCase().endsWith('main.cpp'))`);
    check(out.includes('Build failed with 1 errors') && problem?.line === 4 && problem.col === 5 && /undefined_name/.test(problem.msg), `a g++ error is listed in Problems at its line and column ${q(problem)}`);
    check(await a.js(`!!document.querySelector('.squiggly-error, .monaco-editor .squiggly-error')`) || await a.js(`ide.monaco.editor.getModelMarkers({}).some((m) => m.owner === 'gcc')`), 'the error is marked in the editor');
    await a.shot('cpp-problems.png');

    const c = await create(a, 'cpp', 'chello', `document.querySelector('input[name="npLang"][value="c"]').click()`);
    await a.until(`ide.activeTab()?.title === 'main.c'`, 'main.c opened');
    out = await runAndWait(a, 'shift-f10');
    check(out.includes('Hello, World!') && /gcc\.exe/.test(out.split('\n')[0]) && out.includes('-std=c17') && existsSync(path.join(c, 'build', 'chello.exe')), `a C project builds with gcc -std=c17 and runs (${q(out.split('\n')[0])})`);
    check(await a.js(`ide.problems.all().every((p) => !p.path.toLowerCase().endsWith('main.cpp'))`), 'a successful build clears its old Problems');
  }
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${q(a.consoleErrors)}` : ''}`);
  a.close();
} catch (err) {
  check(false, err.message);
  a?.close();
}
server?.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
