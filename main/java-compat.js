// Whether the JDK a Gradle project would be imported and built with can do it. Gradle runs on a range of Java
// versions, and a newer JDK than its last stops it at once ("Can't use Java 25 and Gradle 8.14.3 to import Gradle
// project"): the editor then shows every import as unresolved. A build may also name the Java it compiles with
// (a toolchain), which Gradle must find on the computer unless the build can download it.
const fs = require('fs');
const path = require('path');

// The first Gradle version that runs on each Java (Gradle's compatibility matrix), newest first.
const GRADLE_JAVA = [['9.1', 25], ['8.14', 24], ['8.10', 23], ['8.8', 22], ['8.5', 21], ['8.3', 20], ['7.6', 19], ['7.5', 18], ['7.3', 17], ['7.0', 16],
  ['6.7', 15], ['6.3', 14], ['6.0', 13], ['5.4', 12], ['5.0', 11], ['4.7', 10], ['4.3', 9], ['2.0', 8]];
// The JDKs Nano Studio installs itself (main/installer/toolchains.js), by Java version.
const INSTALLABLE = { 25: 'jdk', 21: 'jdk21', 17: 'jdk17' };

const parts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
const atLeast = (v, min) => { const [a, b] = [parts(v), parts(min)]; for (let i = 0; i < 2; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return true; };

// The newest Java a Gradle version runs on; null for a Gradle older than the table.
function gradleMaxJava(version) {
  return GRADLE_JAVA.find(([min]) => atLeast(version, min))?.[1] ?? null;
}

// "25.0.1" -> 25, "1.8.0_402" -> 8
function javaMajor(version) {
  const p = parts(version || '');
  return p[0] === 1 ? p[1] || null : p[0] || null;
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// What a Gradle project at `root` asks for: -> {gradle, wants, autoProvision} | null (no Gradle wrapper to read).
// gradle: the wrapper's version; wants: the Java its toolchain names; autoProvision: the build can download that Java
// itself (a toolchain resolver plugin in the settings file).
function gradleProject(root) {
  const wrapper = read(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  const gradle = wrapper && /^distributionUrl=.*gradle-(\d+(?:\.\d+)*)[^/]*\.zip\s*$/m.exec(wrapper)?.[1];
  if (!gradle) return null;
  const build = read(path.join(root, 'build.gradle')) ?? read(path.join(root, 'build.gradle.kts')) ?? '';
  const settings = read(path.join(root, 'settings.gradle')) ?? read(path.join(root, 'settings.gradle.kts')) ?? '';
  const m = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(build);
  return { gradle, wants: m ? Number(m[1]) : null, autoProvision: /foojay-resolver|toolchainManagement/.test(settings) };
}

// jdks: the detected JDKs ({id, home, version}); usingId: the one the project would use (its own, or the default).
// -> null (not a Gradle wrapper project) | {ok, reason, gradle, maxJava, wants, using: {id, home, version, major} | null,
//    recommend, candidate: a detected JDK that fits | null, installable: a Nano Studio JDK name | null}
// reason: 'gradle' (the JDK is newer than this Gradle runs on), 'toolchain' (the build names a Java no JDK here is),
// 'none' (no JDK at all).
function check(root, jdks, usingId) {
  const p = gradleProject(root);
  if (!p) return null;
  const maxJava = gradleMaxJava(p.gradle);
  const all = jdks.map((j) => ({ id: j.id, home: j.home, version: j.version, major: javaMajor(j.version) })).filter((j) => j.major);
  const using = all.find((j) => j.id === usingId) || all[0] || null;
  const fits = (j) => (!maxJava || j.major <= maxJava) && (!p.wants || p.autoProvision || j.major === p.wants);
  let reason = null;
  if (!using) reason = 'none';
  else if (maxJava && using.major > maxJava) reason = 'gradle';
  else if (p.wants && !p.autoProvision && !all.some((j) => j.major === p.wants)) reason = 'toolchain';
  const recommend = p.wants && (!maxJava || p.wants <= maxJava) ? p.wants : [25, 21, 17, 11, 8].find((v) => !maxJava || v <= maxJava) || null;
  const candidate = all.find((j) => j.major === recommend) || all.filter(fits).sort((a, b) => b.major - a.major)[0] || null;
  return { ok: !reason, reason, gradle: p.gradle, maxJava, wants: p.wants, using, recommend, candidate, installable: INSTALLABLE[recommend] || null };
}

module.exports = { gradleMaxJava, javaMajor, gradleProject, check };
