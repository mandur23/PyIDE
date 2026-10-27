// Java debugging on a real JDK (main/features/debug-jvm.js, a JDWP client): Debug (Shift+F9) on the selected Java
// Application configuration builds with javac -g and starts java with the JDWP agent; it stops at a breakpoint set in
// the gutter, shows the frames, the current line in the editor and the variables (an array, a List, a Map and a record
// expanded), evaluates in the console and the Alt+F8 dialog and in a watch, sets a value, steps into, over and out,
// stops at a conditional breakpoint, and Stop ends the JVM. Rerun runs to the end, a compile error stops before the
// JVM starts, and the Debug window is checked in Korean. Uses a JDK on this computer (17 or later); without one the
// suite is skipped.
import path from 'path';
import { launch, openFile, processSnapshot } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;
const MAIN = 'src/org/example/Main.java';

function helpers(t) {
  const { js, until, cdp } = t;
  // Suspended there with the frame shown: the current-line highlight comes once its variables are in.
  const stoppedAt = (line, ms = 30000) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx];
    return f && f.path?.endsWith('Main.java') && f.line === ${line}
      && ide.editor.getModel()?.getAllDecorations().some((d) => d.options.className === 'dbg-exec-line' && d.range.startLineNumber === ${line}); })()`,
  `suspended at Main.java:${line}`, ms);
  const gutter = async (line, button = 'left') => {
    const p = await js(`(() => { const e = ide.editor; e.revealLineInCenterIfOutsideViewport(${line}); const li = e.getLayoutInfo();
      const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
      return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
    await t.sleep(150);
  };
  const clickText = (sel, text) => js(`(() => { const n = [...document.querySelectorAll(${q(sel)})].find((n) => n.textContent.includes(${q(text)}));
    if (!n) return false; n.id ||= 'jdTmp' + Math.random().toString(36).slice(2); return n.id; })()`)
    .then((id) => { if (!id) throw new Error(`no ${sel} containing ${text}`); return t.click(`#${id}`); });
  const varsText = () => js(`document.querySelector('#dbgVars').textContent`);
  const out = () => js(`document.querySelector('#dbgOut').textContent`);
  const editorKey = async (combo) => { await js(`(ide.editor.focus(), true)`); await t.press(combo); };
  // Selects the Java Application configuration for the fixture's Main class, with the given JDK.
  const selectConfig = (jdk) => js(`(() => { const r = ide.run; const c = r.addTemporary({ ...r.types.get('java').defaults(), type: 'java',
    name: 'Main', mainClass: 'org.example.Main', sourceRoot: 'src', jdk: ${q(jdk)} }); c.temporary = false; r.select(c.id); return true; })()`);
  return { stoppedAt, gutter, clickText, varsText, out, editorKey, selectConfig };
}

const javaProcs = (project) => processSnapshot().filter((p) => /^java(w)?\.exe$/i.test(p.name) && p.cmd?.includes('org.example.Main')
  && p.cmd.toLowerCase().includes(project.toLowerCase()));
async function noJava(project, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!javaProcs(project).length) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const t = await launch({ fixture: 'java-debug', port: 9774, name: 'java-debug' });
const { js, until, press, type, click, check } = t;
const h = helpers(t);
let jdk = null;
try {
  const jdks = await js(`ide.toolchains.list('jdk').then((l) => l.map((x) => ({ id: x.id, version: x.version, home: x.home })))`);
  jdk = jdks.find((j) => parseInt(j.version, 10) >= 21) || jdks.find((j) => parseInt(j.version, 10) >= 17);
  if (!jdk) {
    console.log('SKIP Java debugging: no JDK 17 or later on this computer (Install Manager › Eclipse Temurin JDK installs one)');
    t.close();
    process.exit(0);
  }
  console.log(`JDK ${jdk.version} at ${jdk.home}`);
  await h.selectConfig(jdk.id);
  await openFile(t, MAIN);
  await until(`ide.activeTab()?.title === 'Main.java'`, 'Main.java open');

  // ---- breakpoints: the gutter, Ctrl+F8, a condition in the inline popup ----
  await h.gutter(32);
  await until(`window.__debugger.breakpoints().some((b) => b.line === 32)`, 'breakpoint on line 32');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 19, column: 9 }), true)`);
  await press('Ctrl+F8');
  await until(`window.__debugger.breakpoints().some((b) => b.line === 19)`, 'breakpoint on line 19');
  await h.gutter(19, 'right');
  await until(`!!document.querySelector('#dbgBpPopup #dbgBpCondition')`, 'inline breakpoint popup');
  check(await js(`document.querySelector('#dbgBpCondition').placeholder.startsWith('Java expression')`), 'a .java breakpoint asks for a Java expression');
  await js(`(document.querySelector('#dbgBpCondition').focus(), true)`);
  await type('x == 2');
  await press('Enter');
  await until(`window.__debugger.breakpoints().find((b) => b.line === 19)?.condition === 'x == 2'`, 'condition saved');

  // ---- Debug (Shift+F9) ----
  await h.editorKey('Shift+F9');
  await h.stoppedAt(32, 120000);
  const text = await h.out();
  check(/javac\.exe/.test(text) && /-g\b/.test(text), 'the build runs javac with -g in the Debug console');
  check(/-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127\.0\.0\.1:\d+/.test(text), 'java starts with the JDWP agent listening on 127.0.0.1');
  check(/Connected to the target VM, address: '127\.0\.0\.1:\d+', transport: 'socket'/.test(text), "the console says \"Connected to the target VM, address: '127.0.0.1:…', transport: 'socket'\"");
  check(await js(`ide.toolWindows.get('Debug').isVisible() && !document.querySelector('#dbgTabVars').classList.contains('hidden')`), 'the Debug tool window shows Threads & Variables');
  const frames = await js(`[...document.querySelectorAll('#dbgFrames .dbg-frame')].map((f) => f.textContent)`);
  check(frames[0] === 'Main.main, Main.java:32', `Frames shows Main.main, Main.java:32 (${q(frames)})`);
  check(await js(`document.querySelector('.dbg-thread').textContent.includes('main')`), 'the thread is main');
  check(await js(`ide.editor.getModel().getAllDecorations().some((d) => d.options.className === 'dbg-exec-line' && d.range.startLineNumber === 32)`),
    'the editor highlights the current line 32');
  let vars = await h.varsText();
  check(vars.includes('numbers = {int[3]@') && vars.includes('[3, 1, 4]'), 'numbers = {int[3]@…} [3, 1, 4]');
  check(/names = \{ArrayList@\d+\} size = 2/.test(vars), 'names = {ArrayList@…} size = 2');
  check(/ages = \{HashMap@\d+\} size = 1/.test(vars), 'ages = {HashMap@…} size = 1');
  check(/p = \{Main\$Person@\d+\} "Person\[name=김민수, age=42\]"/.test(vars), 'a record shows its toString(): p = {Main$Person@…} "Person[name=김민수, age=42]"');
  check(vars.includes('greeting = {String} "안녕하세요"') && vars.includes('ratio = {double} 0.5'), 'a Korean String and a double');
  check(!vars.includes('result ='), 'a local of another method is not shown');

  // ---- expanding objects, arrays and collections ----
  await h.clickText('#dbgVars .dbg-var', 'names = ');
  await until(`document.querySelector('#dbgVars').textContent.includes('[1] = {String} "lee"')`, 'List expanded');
  check((await h.varsText()).includes('[0] = {String} "kim"'), 'a List expands to its elements [0] "kim", [1] "lee"');
  await h.clickText('#dbgVars .dbg-var', 'ages = ');
  await until(`/"kim" = \\{Integer@\\d+\\} 30/.test(document.querySelector('#dbgVars').textContent)`, 'Map expanded');
  check(true, 'a Map expands to its entries: "kim" = {Integer@…} 30');
  await h.clickText('#dbgVars .dbg-var', 'p = ');
  await until(`document.querySelector('#dbgVars').textContent.includes('age = {int} 42')`, 'record expanded');
  check((await h.varsText()).includes('name = {String} "김민수"'), 'an object expands to its fields name and age');
  await h.clickText('#dbgVars .dbg-var', 'numbers = ');
  await until(`document.querySelector('#dbgVars').textContent.includes('[2] = {int} 4')`, 'array expanded');
  check(true, 'an array expands to its items');

  // ---- evaluate: the console line, Alt+F8, a watch, Set Value ----
  await click('#dbgTabConsole');
  const evalLine = async (expr) => {
    await js(`(document.querySelector('#dbgConsoleEval').focus(), true)`);
    await type(expr);
    await press('Enter');
    await until(`document.querySelector('#dbgOut').textContent.includes(${q(`>>> ${expr}`)})`, `evaluated ${expr}`);
    await t.sleep(400);
    const all = await h.out();
    return all.slice(all.lastIndexOf(`>>> ${expr}`) + expr.length + 4).trim().split('\n')[0];
  };
  check((await evalLine('names.size() + numbers[2]')) === '6', 'console evaluate: names.size() + numbers[2] -> 6');
  check((await evalLine('p.name().length() * 10')) === '30', 'console evaluate: a call chain on a record -> 30');
  check((await evalLine('ages.get("kim") + 1')) === '31', 'console evaluate: Map.get with a String key, unboxed -> 31');
  check((await evalLine('Math.max(numbers[0], 7)')) === '7', 'console evaluate: a static method of the JDK -> 7');
  check((await evalLine('nosuch + 1')).includes("Cannot find symbol 'nosuch'"), 'console evaluate: an unknown name says so');
  check((await evalLine('ratio = 2.25')) === '2.25', 'console evaluate: an assignment sets the local');
  await click('#dbgTabVars');
  await until(`document.querySelector('#dbgVars').textContent.includes('ratio = {double} 2.25')`, 'ratio set');
  check(true, 'Variables show the value set: ratio = {double} 2.25');

  await h.editorKey('Alt+F8');
  await until(`!!document.querySelector('#dbgEvalInput')`, 'Evaluate dialog');
  await js(`(() => { const i = document.querySelector('#dbgEvalInput'); i.value = 'greeting + "!" + numbers.length'; i.focus(); return true; })()`);
  await press('Enter');
  await until(`document.querySelector('#dbgEvalResult')?.textContent.includes('"안녕하세요!3"')`, 'Evaluate dialog result');
  check(true, 'Alt+F8 evaluates greeting + "!" + numbers.length -> "안녕하세요!3"');
  await press('Escape');

  await click('#dbgWatchAdd');
  await js(`(document.querySelector('#dbgWatchInput').focus(), true)`);
  await type('ratio * 4');
  await press('Enter');
  await until(`document.querySelector('#dbgWatches').textContent.includes('ratio * 4 = {double} 9.0')`, 'watch');
  check(true, 'a watch shows ratio * 4 = {double} 9.0');

  // ---- stepping ----
  await h.editorKey('F7');
  await h.stoppedAt(12);
  check((await js(`window.__debugger.state().frames.map((f) => f.name).join()`)) === 'Main.square,Main.main', 'Step Into (F7) enters square(): frames Main.square, Main.main');
  check((await h.varsText()).includes('x = {int} 3'), 'square() shows its parameter x = 3');
  await h.editorKey('F8');
  await h.stoppedAt(13);
  check((await h.varsText()).includes('result = {int} 9'), 'Step Over (F8) runs line 12: result = 9');
  await h.editorKey('Shift+F8');
  await h.stoppedAt(32);
  check((await js(`window.__debugger.state().frames.length`)) === 1, 'Step Out (Shift+F8) returns to main');
  await h.editorKey('F8');
  await h.stoppedAt(33);
  check((await h.varsText()).includes('s = {int} 9'), 'Step Over finishes line 32: s = 9');
  await h.editorKey('F8');
  await h.stoppedAt(34);
  await until(`document.querySelector('#dbgOut').textContent.includes('s = 9')`, 'program output');
  check(true, "the program's output reaches the Debug console");

  // ---- conditional breakpoint, then Stop ----
  await h.editorKey('F9');
  await h.stoppedAt(19);
  vars = await h.varsText();
  check(vars.includes('x = {int} 2') && vars.includes('sum = {int} 1'), 'the breakpoint with x == 2 suspends on the second item only (x = 2, sum = 1)');
  check(javaProcs(t.project).length === 1, 'one java process runs the program');
  await click('#dbgStop');
  await until(`!window.__debugger.state()`, 'session ended', 15000);
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished with exit code')`, 'exit line');
  check(!(await h.out()).includes('t = 6'), 'Stop ends the program where it was suspended (no output after line 19)');
  check(await noJava(t.project), 'no java process is left after Stop');
  check(await js(`!ide.editor.getModel().getAllDecorations().some((d) => d.options.className === 'dbg-exec-line')`), 'the current-line highlight is gone');

  // ---- Rerun to the end ----
  await click('#dbgRerun');
  // Resume the moment it stops, while the Variables view is still calling toString() in the program: the next
  // breakpoint must still suspend.
  await until(`window.__debugger.state()?.state === 'suspended'`, 'suspended after Rerun', 120000);
  await h.editorKey('F9');
  await h.stoppedAt(19);
  await h.editorKey('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished with exit code 0')`, 'program finished', 30000);
  const done = await h.out();
  check(done.includes('ratio = 0.5') && done.includes('done'), 'Rerun runs the program again and Resume runs it to the end');
  check(/Disconnected from the target VM, address: '127\.0\.0\.1:\d+', transport: 'socket'/.test(done), 'the console says the debugger disconnected');
  check(await noJava(t.project), 'no java process is left after the program ends');

  // ---- a compile error stops before the JVM starts ----
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new ide.monaco.Range(37, 1, 37, m.getLineMaxColumn(37)), text: '        System.out.println("done")' }], () => null); return true; })()`);
  await h.editorKey('Shift+F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('Build failed')`, 'build failed', 120000);
  await t.sleep(500);
  check(!(await js(`window.__debugger.state()`)), 'no debug session starts when javac fails');
  check(await js(`ide.monaco.editor.getModelMarkers({ owner: 'javac' }).some((m) => m.startLineNumber === 37)`), 'the compile error is marked on line 37 (Problems source javac)');
  check(!(await h.out()).includes('-agentlib:jdwp'), 'java is not started');
  await js(`(ide.editor.getModel().undo(), ide.saveAll())`);
} catch (err) {
  check(false, err.message);
  await t.shot('java-debug-failure.png').catch(() => {});
  console.log(`state: ${q(await js('window.__debugger.state()').catch(() => null))}\nconsole:\n${await h.out().catch(() => '')}`);
}
const english = t.results.slice();
t.close();

// ---- Korean ----
let k = null;
if (jdk) {
  k = await launch({ fixture: 'java-debug', port: 9775, name: 'java-debug-ko', lang: 'ko-KR' });
  const hk = helpers(k);
  try {
    await hk.selectConfig(jdk.id);
    await openFile(k, MAIN);
    await k.until(`ide.activeTab()?.title === 'Main.java'`, 'Main.java open');
    await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 32, column: 9 }), true)`);
    await k.press('Ctrl+F8');
    await hk.gutter(32, 'right');
    await k.until(`!!document.querySelector('#dbgBpPopup #dbgBpCondition')`, 'popup');
    k.check(await k.js(`document.querySelector('#dbgBpCondition').placeholder === 'Java 표현식 (예: i == 3)'`), 'the condition placeholder is Korean');
    await k.press('Escape');
    await hk.editorKey('Shift+F9');
    await hk.stoppedAt(32, 120000);
    k.check(/대상 VM에 연결되었습니다\. 주소: '127\.0\.0\.1:\d+', 전송: '소켓'/.test(await hk.out()), '콘솔: 대상 VM에 연결되었습니다');
    k.check((await k.js(`document.querySelector('#dbgTabVars').textContent`)) === '스레드 및 변수', 'the Threads & Variables tab is Korean');
    k.check((await k.js(`document.querySelector('.dbg-thread').textContent`)).includes('중단점'), 'the stop reason is Korean (중단점)');
    const leaks = await englishLeaks(k, '.dbg-root');
    k.check(!leaks.length, `Debug tool window while suspended: no English UI text${leaks.length ? ` (${q(leaks.slice(0, 6))})` : ''}`);
    await k.click('#dbgTabConsole');
    await k.js(`(document.querySelector('#dbgConsoleEval').focus(), true)`);
    await k.type('nosuch');
    await k.press('Enter');
    await k.until(`document.querySelector('#dbgOut').textContent.includes("심볼 'nosuch'을(를) 찾을 수 없습니다")`, 'Korean evaluation error');
    k.check(true, 'an evaluation error is Korean');
    await k.click('#dbgStop');
    await k.until(`!window.__debugger.state()`, 'session ended', 15000);
    k.check(/프로세스가 종료 코드 \d+(으)?로 완료되었습니다|종료 코드/.test(await hk.out()), 'the exit line is Korean');
    const missing = await missingTranslations(k);
    k.check(!missing.length, `every tr() string shown has a Korean entry${missing.length ? ` (${q(missing)})` : ''}`);
    k.check(await noJava(k.project), 'no java process is left');
  } catch (err) {
    k.check(false, err.message);
    await k.shot('java-debug-ko-failure.png').catch(() => {});
  }
  english.push(...k.results);
  k.close();
}
const failed = english.filter((r) => !r.ok).length;
console.log(`${english.length - failed}/${english.length} passed`);
const exceptions = [...t.consoleErrors, ...(k?.consoleErrors || [])];
if (exceptions.length) console.log(`renderer exceptions:\n  ${exceptions.join('\n  ')}`);
process.exit(failed || exceptions.length ? 1 : 0);
