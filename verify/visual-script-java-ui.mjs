// Java visual scripts in the IDE (.jflow; renderer/features/visual-script/index.js, main/features/visual-script.js):
// the canvas opens it, the palette offers Java Expression and Java Code but no Python-only node, Show Code shows the
// Java class, Run (the java-visual-script configuration) runs it with the system JDK and stdin, a runtime error marks
// its node and the console link selects it, Export as Java writes <ClassName>.java, Project tree › New › Visual Script
// (Java) makes one that says hello, and a Korean session has no English in the tab or the palette. Ports 9058-9059.
import { spawnSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, menuRow } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const J = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = '@@PYIDE-VS@@';
const PYTHON = [['py', ['-3']], ['python', []]].find(([cmd, args]) => spawnSync(cmd, [...args, '--version']).status === 0);
const graphText = (source) => {
  const r = spawnSync(PYTHON[0], [...PYTHON[1], '-I', '-X', 'utf8', path.join(HERE, '..', 'renderer', 'features', 'visual-script', 'python', 'py2flow.py')], { input: source, encoding: 'utf8' });
  return `${JSON.stringify(JSON.parse(r.stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER)).slice(MARKER.length)).graph, null, 2)}\n`;
};
const DEMO = graphText(`name = input("What is your name? ")
print(f"Hello {name}!")
for i in range(0, 30, 10):
    print(i)
print("Done")
`);
const BOOM = graphText(`z = 0
print("before")
w = 5 / z
print(w)
`);
const V = 'ide.activeTab().visualScript';
const runText = `(document.querySelector('#runOut')?.textContent || '')`;
const programOutput = `[...document.querySelectorAll('#runOut > span')].filter((s) => !s.classList.contains('cmd') && !s.classList.contains('sys')).map((s) => s.textContent).join('').replace(/\\r\\n/g, '\\n')`;

async function opened(t, name, text) {
  writeFileSync(path.join(t.project, name), text, 'utf8');
  await t.js(`ide.openFile(ide.util.joinPath(ide.root, ${J(name)}))`);
  await t.until(`!!${V}?.graph() && ide.activeTab().path.toLowerCase().endsWith(${J(name)})`, `${name} open`, 20000);
}
async function palette(t) {
  await t.js(`(${V}.openPalette(), true)`);
  await t.until(`!!document.querySelector('.vs-palette')`, 'palette');
  const titles = await t.js(`[...document.querySelectorAll('.vs-palette .vs-pal-row, .vs-palette [data-type]')].map((r) => r.dataset.type || r.textContent.trim())`);
  const cats = await t.js(`[...document.querySelectorAll('.vs-palette .vs-pal-head, .vs-palette .vs-pal-cat')].map((r) => r.textContent.trim())`);
  await t.press('Escape');
  return { titles, cats };
}

const t = await launch({ fixture: 'visual-script-preview', port: 9058, name: 'visual-script-java-ui' });
const { js, until, check, press, type, click } = t;
try {
  await until(`ide.actions.some((a) => a.id === 'VisualScript.ExportJava')`, 'visual-script actions');
  await opened(t, 'demo.jflow', DEMO);
  check(await js(`${V}.graph().nodes.length`) > 5, 'the canvas opens a .jflow file');
  check(await js(`ide.fileIconType('demo.jflow')`) === 'nodeGraph', 'a .jflow has the node graph icon');

  const pal = await palette(t);
  check(pal.titles.some((x) => /java\.expr|Java Expression/.test(x)) && pal.titles.some((x) => /java\.code|Java Code/.test(x)), `the palette offers Java Expression and Java Code (${J(pal.titles.slice(-8))})`);
  check(!pal.titles.some((x) => /py\.(code|expr|call)|Python Code|Python Expression|Call Python/.test(x)), 'the palette offers no Python-only node');
  check(!pal.cats.some((x) => /Project|Packages/.test(x)), `no Project or Packages category (${J(pal.cats)})`);

  // Show Code: the Java class.
  await click('.vs-host:not(.hidden) .vs-show-code');
  await until(`(document.querySelector('.vs-host:not(.hidden) .vs-code-head')?.textContent || '') === 'Java code (read-only)'`, 'code pane');
  await until(`${V}.codePane()?.editor.getModel().getValue().includes('public class Demo')`, 'Java code shown')
    .then(() => check(true, 'Show Code shows the Java class'), () => check(false, 'Show Code shows the Java class'));
  check(await js(`${V}.codePane().editor.getModel().getLanguageId()`) === 'java', 'the code pane highlights Java');

  // Run with stdin.
  await js(`(ide.runAction('RunClass'), true)`);
  await until(`${runText}.includes('What is your name?')`, 'the program asks for a name', 60000);
  check(/java(\.exe)?"? .*demo_jflow\.java/i.test(await js(`${runText}.split('\\n')[0]`)), `the console shows the java command and the generated file (${(await js(`${runText}.split('\\n')[0]`)).slice(0, 160)})`);
  await until(`!document.querySelector('#runIn')?.disabled`, 'stdin');
  await click('#runIn');
  await type('Ada');
  await press('Enter');
  await until(`${runText}.includes('Process finished with exit code')`, 'run finished', 60000);
  const out = await js(programOutput);
  check(out === 'What is your name? Hello Ada!\n0\n10\n20\nDone\n', `Run runs the Java script with the answer typed on stdin (${J(out)})`);

  // A runtime error marks its node.
  await opened(t, 'boom.jflow', BOOM);
  await js(`(ide.runAction('RunClass'), true)`);
  await until(`${runText}.includes('Process finished with exit code 1')`, 'boom finished', 60000);
  const marked = await until(`!!document.querySelector('.vs-host:not(.hidden) .vs-runtime-err')`, 'node marked', 10000).then(() => true, () => false);
  const msg = await js(`document.querySelector('.vs-host:not(.hidden) .vs-runtime-err .vs-runtime')?.textContent || ''`);
  check(marked && /ZeroDivisionError: division by zero/.test(msg), `the node that divides by zero is marked with the error (${msg})`);
  check(await js(`[...document.querySelectorAll('#runOut a.vs-node-link')].length`) >= 1, 'the console offers a link to the node');

  // Export as Java.
  await opened(t, 'demo.jflow', DEMO);
  await js(`(ide.runAction('VisualScript.ExportJava'), true)`);
  await until(`ide.activeTab()?.path.endsWith('Demo.java')`, 'Demo.java opened', 20000);
  const exported = readFileSync(path.join(t.project, 'Demo.java'), 'utf8');
  check(/public class Demo \{/.test(exported) && /static final class Rt/.test(exported), 'Export as Java writes Demo.java with the class and its runtime');

  // New › Visual Script (Java).
  await js(`(() => { const items = ide.treeNewItems.flatMap((fn) => fn({ path: ide.root, dir: true }) || []); const nw = items.find((i) => i.label === 'New'); const sub = typeof nw.submenu === 'function' ? nw.submenu() : nw.submenu; window.__javaNew = sub.find((i) => i.label === 'Visual Script (Java)'); return !!window.__javaNew; })()`)
    .then((ok) => check(ok, 'Project tree › New offers Visual Script (Java)'));
  await js(`(window.__javaNew.run(), true)`);
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'name prompt');
  await type('hello');
  await press('Enter');
  await until(`ide.activeTab()?.path.endsWith('hello.jflow') && !!${V}?.graph()`, 'hello.jflow opened', 20000);
  await js(`(ide.runAction('RunClass'), true)`);
  await until(`${runText}.includes('Process finished with exit code 0')`, 'hello finished', 60000);
  check(await js(programOutput) === 'Hello\n', `the new Java script says Hello (${J(await js(programOutput))})`);
} catch (err) {
  check(false, err.message);
}
t.close();
const earlier = t.results;

// ---------------- Korean ----------------
const k = await launch({ fixture: 'visual-script-preview', port: 9059, name: 'visual-script-java-ui-ko', lang: 'ko-KR' });
k.results.push(...earlier);
try {
  await k.until(`ide.actions.some((a) => a.id === 'VisualScript.ExportJava')`, 'visual-script actions');
  await opened(k, 'demo.jflow', DEMO);
  const leaks = await englishLeaks(k, '.vs-host:not(.hidden) .vs-toolbar, .vs-host:not(.hidden) .vs-status');
  k.check(!leaks.length, `the Java script's toolbar and status have no English (${J(leaks)})`);
  await k.js(`(${V}.openPalette(), true)`);
  await k.until(`!!document.querySelector('.vs-palette')`, 'palette');
  k.check(await k.js(`document.querySelector('.vs-palette').textContent.includes('Java 식') && document.querySelector('.vs-palette').textContent.includes('Java 코드')`), 'the palette names Java Expression and Java Code in Korean');
  await k.press('Escape');
} catch (err) {
  k.check(false, err.message);
}
k.finish();
