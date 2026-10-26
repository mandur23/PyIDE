// Pure Node with the system Python and JDK: Java visual scripts (.jflow; codegen.js with language 'java', the `java`
// hooks in nodes.js, the runtime class Rt). Each graph (made from a Python program by python/py2flow.py) is compiled
// to Python and to Java, both are run with the same input, and the Java one must print, exit and fail like the Python
// one. Also: Python-only nodes are problems in Java and Java-only nodes in Python, Java keywords as names, the class
// name, Java Expression and Java Code, the line map against a real stack trace, and that every program compiles.
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(APP, 'renderer', 'features', 'visual-script');
require(path.join(DIR, 'model.js'));
require(path.join(DIR, 'nodes.js'));
const VS = require(path.join(DIR, 'codegen.js'));
const MARKER = '@@PYIDE-VS@@';
const J = JSON.stringify;

let total = 0;
let failed = 0;
const check = (ok, label, detail) => {
  total++;
  if (ok) return;
  failed++;
  console.log(`FAIL ${label}${detail === undefined ? '' : `\n${detail}`}`);
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'pyide-vs-java-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const PYTHON = [['py', ['-3']], ['python', []]].find(([cmd, args]) => spawnSync(cmd, [...args, '--version']).status === 0);
const javaHome = process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
const pf = process.env.ProgramFiles || 'C:\\Program Files';
const installed = existsSync(path.join(pf, 'Java')) ? readdirSync(path.join(pf, 'Java')).map((d) => path.join(pf, 'Java', d, 'bin', 'java.exe')).filter(existsSync).sort().reverse() : [];
const JAVA = [javaHome, 'java', ...installed].filter(Boolean).find((cmd) => spawnSync(cmd, ['-version']).status === 0);
if (!PYTHON || !JAVA) {
  console.log(`FAIL needs Python and a JDK (Python: ${!!PYTHON}, Java: ${!!JAVA})`);
  process.exit(1);
}
const python = (args, input = '') => spawnSync(PYTHON[0], [...PYTHON[1], '-I', '-X', 'utf8', ...args], { input, encoding: 'utf8', timeout: 30000, cwd: tmp });
const java = (file, input = '') => spawnSync(JAVA, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', file], { input, encoding: 'utf8', timeout: 60000, cwd: tmp });
const graphOf = (source) => {
  const r = python([path.join(DIR, 'python', 'py2flow.py')], source);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  return VS.parse(JSON.stringify(JSON.parse(line.slice(MARKER.length)).graph));
};
// The error type of an uncaught exception: Python's last stderr line, Java's message after RuntimeException.
const errorType = (stderr) => {
  const lines = (stderr || '').trim().split(/\r?\n/);
  const javaLine = lines.find((l) => /java\.lang\.RuntimeException: /.test(l));
  const text = javaLine ? javaLine.split('RuntimeException: ')[1] : lines.pop() || '';
  return text.split(':')[0];
};
let seq = 0;
function both(name, g, input = '') {
  const py = VS.compile(g, { fileName: `${name}.pyflow` });
  const jv = VS.compile(g, { fileName: `${name}.jflow`, language: 'java' });
  const jErrors = jv.errors.filter((e) => !e.warning);
  check(!jErrors.length, `${name}: compiles to Java without problems`, J(jErrors));
  const pyFile = path.join(tmp, `p${++seq}.py`);
  writeFileSync(pyFile, py.code, 'utf8');
  const javaFile = path.join(tmp, `j${seq}_jflow.java`);
  writeFileSync(javaFile, jv.code, 'utf8');
  const a = python([pyFile], input);
  const b = java(javaFile, input);
  const compileError = /error:/.test(b.stderr || '') && b.status !== 0 && !/RuntimeException/.test(b.stderr);
  check(!compileError, `${name}: the Java source compiles`, `${(b.stderr || '').slice(0, 1500)}\n--- java ---\n${jv.code.split('\n').slice(0, 80).join('\n')}`);
  const same = a.stdout.replace(/\r\n/g, '\n') === b.stdout.replace(/\r\n/g, '\n') && a.status === b.status && errorType(a.stderr) === errorType(b.stderr);
  check(same, `${name}: the Java version prints, exits and fails like the Python version`,
    `python (exit ${a.status}, ${errorType(a.stderr)}): ${J(a.stdout)}\njava (exit ${b.status}, ${errorType(b.stderr)}): ${J(b.stdout)}\n${(b.stderr || '').slice(0, 600)}`);
  return { py, jv, javaFile, run: b };
}

// ---------- programs ----------
both('basics', graphOf(`name = input("Name: ")
age = int(input("Age: "))
print(f"Hello {name}, you are {age}")
total = 0
for i in range(1, 6):
    if i % 2 == 0:
        continue
    total += i
print(total)
items = [3, 1, 2]
items.append(10)
for item in items:
    if item > 5:
        print(f"big {item}")
        break
    print(item)
count = len(items)
first = items[0]
last = items[-1]
print(f"{count} {first} {last}")
n = 3
while n > 0:
    print(n)
    n -= 1
if total > 100:
    print("large")
elif total > 5:
    print("medium")
else:
    print("small")
`), 'Ann\n41\n');

both('functions', graphOf(`def area(w, h):
    return w * h


def fact(n):
    result = 1
    for k in range(2, n + 1):
        result *= k
    return result


def show(label, value):
    print(f"{label}: {value}")


scale = 2
print(area(2, 5) * scale)
print(fact(10))
a = area(3, 4)
show("area", a)
`));

both('numbers', graphOf(`a = 7
b = -3
for v in [a / 2, a // 2, a % 3, b // 2, b % 2, a ** 2, 2 ** 10, a / 4]:
    print(v)
x = 0.1 + 0.2
big = 12345678.5 * 1000
for v in [x, x * 10, a / 3, x / 100000, big, big * 100000000, -0.5 * 4]:
    print(v)
zero = 0
for v in [a > b, a == b, a != b, b <= -3, a >= 7, b < a, a and b, zero or a, not a, -a]:
    print(v)
`));

both('text', graphOf(`name = "Ann"
n = 3
s = "ab"
for v in [s * n, len(name), name[0], name[-1]]:
    print(v)
q = n / 7
r = n * 2.5
print(f"{name:>6}|{n:03d}|{q:.3f}|{name!r}|{r:8.2f}|{name:^7}|{n:<4}|")
items = [1, "two", 3.5, True, None]
print(items)
print(items[1])
for v in [int("42") + 1, float("2.5") * 2, int(q * 100), str(n)]:
    print(v)
`));

both('loops', graphOf(`total = 0
i = 0
while True:
    i += 1
    if i > 10:
        break
    if i % 2 == 0:
        continue
    total += i
print(total)
print(i)
for k in range(10, 0, -3):
    print(k)
words = ["a", "b"]
letters = "xy"
for w in words:
    for ch in letters:
        print(w + ch)
`));

both('zero division', graphOf(`z = 0
print("before")
print(5 / z)
`));
both('index error', graphOf(`items = [1]
print(items[3])
`));
both('type error', graphOf(`a = "x"
b = 1
print(a + b)
`));
both('eof', graphOf(`x = input("? ")
print(x)
`), '');

// ---------- the line map follows a real Java stack trace to the node ----------
{
  const g = graphOf(`z = 0
print("ok")
w = 7 / z
print(w)
`);
  const { jv, run } = both('trace', g);
  const m = /^\s*at (?![\w$]*\$Rt\.)[\w$.]+\(j\d+_jflow\.java:(\d+)\)/m.exec(run.stderr || '');
  const node = m && jv.map[Number(m[1])];
  check(!!node && g.nodes.find((n) => n.id === node)?.type === 'var.set', `trace: the stack trace's line maps to the Set Variable that divides (${m?.[1]} -> ${node})`);
}

// ---------- the class ----------
check(VS.javaClassName('demo.jflow') === 'Demo' && VS.javaClassName('my game.jflow') === 'My_game' && VS.javaClassName('1st.jflow') === 'Script_1st' && VS.javaClassName('class.jflow') === 'Class',
  `class names from file names (${['demo.jflow', 'my game.jflow', '1st.jflow', 'class.jflow'].map(VS.javaClassName).join(', ')})`);

// ---------- language-only nodes and names ----------
const withStart = (nodes, links) => VS.parse(JSON.stringify({ format: 1, nodes: [{ id: 'n1', type: 'core.start', x: 0, y: 0 }, ...nodes], links }));
const link = (a, ap, b, bp) => ({ from: { node: a, pin: ap }, to: { node: b, pin: bp } });
{
  const g = withStart([{ id: 'n2', type: 'py.code', x: 0, y: 0, props: { code: 'print(1)', inputs: '' } }], [link('n1', 'next', 'n2', 'in')]);
  const r = VS.compile(g, { fileName: 'a.jflow', language: 'java' });
  check(r.errors.some((e) => e.node === 'n2' && /only in Python/.test(e.message)) && /throw new RuntimeException/.test(r.code), `Python Code in a Java script is a problem that raises at run time (${J(r.errors)})`);
  const g2 = withStart([{ id: 'n2', type: 'java.code', x: 0, y: 0, props: { code: 'System.out.println(1);', inputs: '' } }], [link('n1', 'next', 'n2', 'in')]);
  const r2 = VS.compile(g2, { fileName: 'a.pyflow' });
  check(r2.errors.some((e) => e.node === 'n2' && /only in Java/.test(e.message)), `Java Code in a Python script is a problem (${J(r2.errors)})`);
  const g3 = withStart([{ id: 'n2', type: 'var.set', x: 0, y: 0, props: { name: 'class' }, inputs: { value: 1 } }], [link('n1', 'next', 'n2', 'in')]);
  const r3 = VS.compile(g3, { fileName: 'a.jflow', language: 'java' });
  check(r3.errors.some((e) => /Java keyword/.test(e.message)), `a Java keyword is refused as a variable name (${J(r3.errors)})`);
  const r4 = VS.compile(withStart([{ id: 'n2', type: 'var.set', x: 0, y: 0, props: { name: 'Rt' }, inputs: { value: 1 } }], [link('n1', 'next', 'n2', 'in')]), { fileName: 'a.jflow', language: 'java' });
  check(r4.errors.some((e) => /already used by the generated code/.test(e.message)), 'a name the class uses (Rt) is refused');
}

// ---------- Java Expression and Java Code ----------
{
  const g = withStart([
    { id: 'n2', type: 'var.set', x: 0, y: 0, props: { name: 'word' }, inputs: { value: 'héllo' } },
    { id: 'n3', type: 'var.get', x: 0, y: 0, props: { name: 'word' } },
    { id: 'n4', type: 'java.expr', x: 0, y: 0, props: { code: '((String) w).toUpperCase() + " // not a comment"', inputs: 'w' } },
    { id: 'n5', type: 'io.print', x: 0, y: 0 },
    { id: 'n6', type: 'java.code', x: 0, y: 0, props: { code: 'StringBuilder b = new StringBuilder((String) s);\nreversed = b.reverse().toString();', inputs: 's', outputs: 'reversed' } },
    { id: 'n7', type: 'io.print', x: 0, y: 0 },
    { id: 'n8', type: 'var.get', x: 0, y: 0, props: { name: 'word' } },
  ], [link('n1', 'next', 'n2', 'in'), link('n2', 'next', 'n5', 'in'), link('n3', 'value', 'n4', 'w'), link('n4', 'result', 'n5', 'value'),
    link('n5', 'next', 'n6', 'in'), link('n8', 'value', 'n6', 's'), link('n6', 'next', 'n7', 'in'), link('n6', 'reversed', 'n7', 'value')]);
  const r = VS.compile(g, { fileName: 'expr.jflow', language: 'java' });
  check(!r.errors.filter((e) => !e.warning).length, `Java Expression and Java Code compile (${J(r.errors)})`);
  const file = path.join(tmp, 'expr_jflow.java');
  writeFileSync(file, r.code, 'utf8');
  const out = java(file);
  check(out.stdout.replace(/\r\n/g, '\n') === 'HÉLLO // not a comment\nolléh\n', `Java Expression and Java Code run with their inputs (${J(out.stdout)} ${out.stderr.slice(0, 400)})`);
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
