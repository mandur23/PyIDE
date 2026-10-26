// Pure Node (no window): renderer/features/visual-script/python/py2flow.py turns .py files into graphs. Each program
// below is converted with the system Python, the graph is parsed and compiled by model.js, nodes.js and codegen.js, and
// the generated Python must print the same and exit the same as the original with the same input. Also: which
// statements stay Python Code, the line ranges of nodes, comments, a syntax error, and layout without overlaps.
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(APP, 'renderer', 'features', 'visual-script');
require(path.join(DIR, 'model.js'));
require(path.join(DIR, 'nodes.js'));
const VS = require(path.join(DIR, 'codegen.js'));
const HELPER = path.join(DIR, 'python', 'py2flow.py');
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'pyide-vs-frompy-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const PYTHON = [['py', ['-3']], ['python', []]].find(([cmd, args]) => spawnSync(cmd, [...args, '--version']).status === 0);
if (!PYTHON) {
  console.log('FAIL no Python found (tried py -3 and python)');
  process.exit(1);
}
const python = (args, input = '') => spawnSync(PYTHON[0], [...PYTHON[1], '-I', '-X', 'utf8', ...args], { input, encoding: 'utf8', timeout: 30000, cwd: tmp });
const convert = (source) => {
  const r = python([HELPER], source);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (!line) throw new Error(`py2flow printed no result: ${r.stderr.slice(-600)}`);
  return JSON.parse(line.slice(MARKER.length));
};
let seq = 0;
const runFile = (code, input) => {
  const file = path.join(tmp, `prog${++seq}.py`);
  writeFileSync(file, code, 'utf8');
  const r = python([file], input);
  return { out: r.stdout, err: (r.stderr || '').trim().split(/\r?\n/).pop() || '', code: r.status };
};
const counts = (g) => g.nodes.reduce((m, n) => ({ ...m, [n.type]: (m[n.type] || 0) + 1 }), {});

// Converts, compiles and runs; returns the graph and result for further checks.
function same(name, source, { input = '', fallback, has = [] } = {}) {
  let r;
  try { r = convert(source); } catch (err) { check(false, `${name}: converts`, err.message); return null; }
  check(r.ok, `${name}: converts`, J(r.error));
  if (!r.ok) return null;
  let graph;
  try { graph = VS.parse(JSON.stringify(r.graph)); } catch (err) { check(false, `${name}: the graph parses`, err.message); return null; }
  const c = VS.compile(graph, { fileName: `${name}.pyflow` });
  const errors = c.errors.filter((e) => !e.warning);
  check(!errors.length, `${name}: the graph compiles without problems`, J(errors.map((e) => `${e.node}: ${e.message}`)) + '\n' + c.code);
  const want = runFile(source, input);
  const got = runFile(c.code, input);
  check(got.out === want.out && got.code === want.code && got.err.split(':')[0] === want.err.split(':')[0],
    `${name}: the generated code prints and exits as the original`,
    `original (exit ${want.code}): ${J(want.out)} ${want.err}\ngraph (exit ${got.code}): ${J(got.out)} ${got.err}\n--- generated ---\n${c.code}`);
  const n = counts(graph);
  if (fallback !== undefined) check((n['py.code'] || 0) - (r.graph.nodes.some((x) => x.type === 'py.code' && /^global /.test(x.props?.code)) ? 1 : 0) === fallback,
    `${name}: ${fallback} statement(s) stay Python Code (${n['py.code'] || 0} Python Code nodes)`, J(graph.nodes.filter((x) => x.type === 'py.code').map((x) => x.props.code)));
  for (const t of has) check((n[t] || 0) > 0, `${name}: has a ${t} node`, J(n));
  return { r, graph, c };
}

// ---------- basic scripts become nodes only ----------
const basics = same('basics', `# A small program
name = input("Name: ")
age = int(input("Age: "))
print(f"Hello {name}, next year you are {age + 1}" if False else f"Hello {name}!")
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
        print("big", item)
        break
    print(item)
print(len(items), items[0])
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
print("done")
`, { input: 'Ann\n41\n', fallback: 0, has: ['io.input', 'flow.forRange', 'flow.forEach', 'flow.while', 'flow.if', 'flow.break', 'flow.continue', 'list.append', 'list.len', 'list.get', 'math.binary', 'math.compare', 'var.set', 'var.get', 'ui.comment'] });
if (basics) {
  const { r, graph } = basics;
  const io = graph.nodes.find((x) => x.type === 'io.input');
  check(J(r.lines[io.id]) === J([2, 2]), `basics: the first Ask User maps to line 2 (${J(r.lines[io.id])})`);
  const comment = graph.nodes.find((x) => x.type === 'ui.comment');
  check(comment?.props.text === 'A small program', `basics: the comment line becomes a Comment node (${J(comment?.props)})`);
  const toInt = graph.nodes.find((x) => x.type === 'convert.int');
  check(!!toInt && graph.links.some((l) => l.to.node === toInt.id && graph.nodes.find((x) => x.id === l.from.node)?.type === 'io.input'),
    'basics: int(input(...)) is Ask User wired into To Integer');
  const top = graph.nodes.find((x) => x.type === 'flow.if' && r.lines[x.id][0] === 23);
  const after = top && graph.links.find((l) => l.from.node === top.id && l.from.pin === 'done');
  check(!!after && r.lines[after.to.node]?.[0] === 29, `basics: the print after the if/elif/else follows the If's Done (${J(after)})`);
}

// ---------- functions ----------
same('functions', `def area(w, h):
    return w * h


def describe(w, h):
    a = area(w, h)
    return f"{w}x{h} = {a}"


def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)


def count_up(limit):
    for k in range(limit):
        print("k", k)


scale = 2
print(describe(3, 4))
print(area(2, 5) * scale)
print(fact(5))
count_up(3)
`, { fallback: 0, has: ['fn.define', 'fn.call', 'fn.return'] });

same('shared local names', `def first(xs):
    result = 0
    for x in xs:
        result += x
    return result


def second(xs):
    result = 1
    for x in xs:
        result *= x
    return result


result = first([1, 2, 3]) + second([2, 3])
print(result)
`, { fallback: 2 });

same('recursion with its own variables', `def fib(n):
    a = n - 1
    if n < 2:
        return n
    return fib(a) + fib(n - 2)


print(fib(10))
`, { fallback: 1 });

same('globals and counters', `count = 0


def bump():
    global count
    count += 1


for _ in range(3):
    bump()
print(count)
`, { fallback: 1 });

// ---------- what stays Python Code ----------
same('python features', `import math
from collections import Counter


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def dist(self):
        return math.sqrt(self.x ** 2 + self.y ** 2)


def norm(p):
    return round(p.dist(), 3)


p = Point(3, 4)
print(norm(p))
words = "a b a c b a".split()
c = Counter(words)
print(sorted(c.items()))
squares = [k * k for k in range(5)]
print(squares, sum(squares))
pair = (1, 2)
x, y = pair
print(x + y)
try:
    print(1 / 0)
except ZeroDivisionError as err:
    print("error:", err)
d = {"a": 1}
d["b"] = 2
print(d)
f = lambda v: v + 1
print(f(1), math.pi > 3, "a" in "abc", x is None, 1 < x < 3, "yes" if x else "no")
print("a", "b", sep="-")
`, { has: ['fn.define', 'py.code', 'py.expr'] });

const guard = same('main guard', `def main():
    total = 0
    for i in range(4):
        total += i
    print("total", total)


if __name__ == "__main__":
    main()
`, { fallback: 1, has: ['py.call', 'flow.if'] });
check(guard?.graph.nodes.some((x) => x.type === 'py.call' && x.props.function === 'main'), 'main guard: main() is a Call Python node');

// ---------- loop variables ----------
same('loop variables', `for i in range(3):
    pass
print(i)
for j in range(2):
    for k in range(2):
        print(j, k)
for w in ["x", "y"]:
    w = w.upper()
    print(w)
for q in range(2):
    print(q)
else:
    print("else")
`);

// ---------- literals ----------
same('literals', `print(1.0, 0.1, 1e20, 2 ** 70, -5, -2.5, None, True, False)
x = 1.0
y = -3
z = 10 ** 30
s = "brace {x} and \\"quote\\""
print(x, y, z, s)
print(f"{x:.2f}|{y!r}|{s}|{{literal}}")
big = 12345678901234567890
print(big + 1)
`);

// ---------- evaluation order ----------
same('evaluation order', `log = []


def note(v):
    log.append(v)
    return v


a = 1
b = a + note(2)
c = note(3) + note(4)
print(b, c, log)
n = 5 + int(input())
print(n)
`, { input: '7\n' });

// ---------- syntax error ----------
{
  const r = convert('print("x"\nif :\n');
  check(r.ok === false && r.error && r.error.line >= 1, `a syntax error is reported with its line (${J(r.error)})`);
}

// ---------- empty file ----------
same('empty', '');

// ---------- layout: no two nodes start at the same place ----------
if (basics) {
  const places = new Set(basics.graph.nodes.map((n) => `${n.x},${n.y}`));
  check(places.size === basics.graph.nodes.length, `layout: every node has a place of its own (${places.size} of ${basics.graph.nodes.length})`);
}

// ---------- every fixture .py of the verify suites converts and compiles ----------
{
  const files = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (!['node_modules', '.venv'].includes(d.name)) walk(p); } else if (d.name.endsWith('.py')) files.push(p);
    }
  };
  walk(path.join(APP, 'verify', 'fixtures'));
  let ok = 0;
  const bad = [];
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    if (python(['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], source).status !== 0) continue;
    try {
      const r = convert(source);
      const c = VS.compile(VS.parse(JSON.stringify(r.graph)), { fileName: 'x.pyflow' });
      const errors = c.errors.filter((e) => !e.warning);
      if (r.ok && !errors.length) ok++;
      else bad.push(`${path.relative(APP, f)}: ${r.ok ? errors.map((e) => e.message).join('; ') : J(r.error)}`);
    } catch (err) { bad.push(`${path.relative(APP, f)}: ${err.message.slice(0, 200)}`); }
  }
  check(!bad.length && ok > 100, `fixtures: ${ok} .py files convert to graphs without problems`, bad.slice(0, 15).join(String.fromCharCode(10)));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
