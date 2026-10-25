// Pure Node (no window): the code-generation requests of renderer/features/refactor/refactor_server.py (quickFixes,
// generate, classEntry, classMembers, insertMethods) on small projects, run in the IDE's default Python (`py -3`, else
// `python`; PYIDE_TEST_PYTHON picks another one, e.g. a 3.11 for the f-string quote rules before PEP 701). No rope.
import { execFileSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'renderer', 'features', 'refactor', 'refactor_server.py');
const hasPy = () => spawnSync('py', ['-3', '--version'], { windowsHide: true }).status === 0;
const [PYTHON, ...PY_ARGS] = process.env.PYIDE_TEST_PYTHON ? [process.env.PYIDE_TEST_PYTHON] : hasPy() ? ['py', '-3'] : ['python'];
const root = mkdtempSync(path.join(tmpdir(), 'pyide-cg-'));

const proc = spawn(PYTHON, [...PY_ARGS, '-u', SCRIPT], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
const pending = new Map();
let buf = '';
let nextId = 1;
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    pending.get(msg.id)?.(msg);
  }
});
let stderr = '';
proc.stderr.on('data', (d) => { stderr += d; });
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(`${JSON.stringify({ id, method, params: { root, ...params } })}\n`);
});

let passed = 0;
let failed = 0;
function check(ok, label) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}
const J = JSON.stringify;

function project(files) {
  const dir = mkdtempSync(path.join(root, 'p-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return (rel) => path.join(dir, rel);
}
// 1-based line and column of the nth match of needle (plus offset) in text.
function at(text, needle, offset = 0, nth = 0) {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`${needle} not found`);
  const before = text.slice(0, i + offset).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}
const range = (text, needle, nth = 0) => {
  const s = at(text, needle, 0, nth);
  const e = at(text, needle, needle.length, nth);
  return { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
};
const newText = (r, file) => r.result?.changes.find((c) => c.path.toLowerCase() === file.toLowerCase())?.new;

async function fixesAt(file, text, pos, diagnostics = []) {
  const r = await call('quickFixes', { file, pos, diagnostics, overlay: { [file]: text } });
  return r.result?.fixes || [];
}
async function apply(file, text, fix, overlay = {}) {
  return call('generate', { file, fix, overlay: { [file]: text, ...overlay } });
}

try {
  // ---------- Create function / class / local variable ----------
  {
    const P = project({});
    const file = P('main.py');
    const text = 'import os\n\n\ndef main(items):\n    total = compute_total(items, 2)\n    return total\n\n\nmain([])\n';
    const fixes = await fixesAt(file, text, at(text, 'compute_total', 3), [{ code: 'reportUndefinedVariable', range: range(text, 'compute_total') }]);
    check(J(fixes.map((f) => f.kind)) === J(['createFunction', 'createClass']), `an undefined call offers Create function, then Create class (${J(fixes.map((f) => f.kind))})`);
    const r = await apply(file, text, fixes[0]);
    check(newText(r, file) === 'import os\n\n\ndef compute_total(items, param):\n    pass\n\n\ndef main(items):\n    total = compute_total(items, 2)\n    return total\n\n\nmain([])\n',
      `Create function puts def compute_total(items, param) above the function that calls it, PEP 8 spaced (${J(newText(r, file))})`);
    check(J(r.result.place) === J({ path: file, line: 5, col: 5, select: true }), `the caret goes to pass, to be typed over (${J(r.result.place)})`);
    const cls = await apply(file, text, fixes[1]);
    check(newText(cls, file).includes('class compute_total:\n    def __init__(self, items, param):\n        pass\n\n\ndef main'), 'Create class writes a class with __init__ taking the call arguments');
  }
  {
    const P = project({});
    const file = P('app.py');
    const text = 'class Repo:\n    pass\n\n\nasync def run():\n    user = await Fetcher(url="x", *rest)\n';
    const fixes = await fixesAt(file, text, at(text, 'Fetcher', 1), [{ code: 'reportUndefinedVariable', range: range(text, 'Fetcher') }]);
    check(J(fixes.map((f) => f.kind)) === J(['createClass', 'createFunction']), 'a capitalized call offers Create class first');
    const twice = 'shapes = [Rect(2, 3), Rect(1, 1)]\n';
    const both = await fixesAt(file, twice, at(twice, 'Rect', 1, 1), [0, 1].map((n) => ({ code: 'reportUndefinedVariable', range: range(twice, 'Rect', n) })));
    check(J(both.map((f) => [f.kind, f.at.col])) === J([['createClass', 11], ['createFunction', 11]]), `a name used twice on the line gives each fix once (${J(both)})`);
    const r = await apply(file, text, fixes[1]);
    check(newText(r, file).includes('async def Fetcher(*args, url):\n    pass\n\n\nasync def run():') === false
      && newText(r, file).includes('async def Fetcher(url, *args):\n    pass\n\n\nasync def run():'), `an awaited call creates an async def; keywords and *args become parameters (${J(newText(r, file))})`);
  }
  {
    const P = project({});
    const file = P('calc.py');
    const text = 'def area(r):\n    if r > 0:\n        return r * r * pi\n    elif r == limit:\n        return 0\n';
    const fixes = await fixesAt(file, text, at(text, 'pi'), [{ code: 'reportUndefinedVariable', range: range(text, 'pi') }]);
    check(J(fixes.map((f) => f.kind)) === J(['createVariable']), 'an undefined name that is not called offers Create local variable');
    const r = await apply(file, text, fixes[0]);
    check(newText(r, file) === 'def area(r):\n    if r > 0:\n        pi = None\n        return r * r * pi\n    elif r == limit:\n        return 0\n',
      `Create local variable adds pi = None above the statement (${J(newText(r, file))})`);
    check(r.result.place.line === 3 && r.result.place.col === 14, 'the caret selects None');
    const elif = await fixesAt(file, text, at(text, 'limit'), [{ code: 'reportUndefinedVariable', range: range(text, 'limit') }]);
    const r2 = await apply(file, text, elif[0]);
    check(newText(r2, file) === 'def area(r):\n    limit = None\n    if r > 0:\n        return r * r * pi\n    elif r == limit:\n        return 0\n',
      `a name in an elif test is created above the whole if (${J(newText(r2, file))})`);
    const variable = async (src, name) => {
      const fx = await fixesAt(file, src, at(src, name), [{ code: 'reportUndefinedVariable', range: range(src, name) }]);
      return newText(await apply(file, src, fx[0]), file);
    };
    const elsewhere = await variable('def f(flag):\n    if flag:\n        elsewhere = missing + 1\n', 'missing');
    check(elsewhere === 'def f(flag):\n    if flag:\n        missing = None\n        elsewhere = missing + 1\n',
      `a statement whose first word only starts with "else" keeps the variable in its block (${J(elsewhere)})`);
    const decorated = await variable('import functools\n\n\n@functools.cache\ndef f():\n    else_value = missing\n    return else_value\n', 'missing');
    check(decorated === 'import functools\n\n\n@functools.cache\ndef f():\n    missing = None\n    else_value = missing\n    return else_value\n',
      `in a decorated function the variable stays in the function (${J(decorated)})`);
    const oneLine = await variable('def g(a):\n    if a:\n        return 1\n    else: return missing\n', 'missing');
    check(oneLine === 'def g(a):\n    missing = None\n    if a:\n        return 1\n    else: return missing\n',
      `a statement on the else line itself is created above the whole if (${J(oneLine)})`);
    const semicolon = await variable('def f(a):\n    x = 1; y = missing\n', 'missing');
    check(semicolon === 'def f(a):\n    missing = None\n    x = 1; y = missing\n', `a second statement after ; stays in its function (${J(semicolon)})`);
    const handler = await variable('def f():\n    try:\n        pass\n    except OSError: return missing\n', 'missing');
    check(handler === 'def f():\n    missing = None\n    try:\n        pass\n    except OSError: return missing\n', `a statement on an except line goes above the try (${J(handler)})`);
  }
  {
    const P = project({});
    const file = P('tool.py');
    const create = async (src) => {
      const fx = await fixesAt(file, src, at(src, 'main', 1), [{ code: 'reportUndefinedVariable', range: range(src, 'main') }]);
      return newText(await apply(file, src, fx.find((f) => f.kind === 'createFunction')), file);
    };
    const cookie = await create('#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nmain()\n');
    check(cookie === '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\ndef main():\n    pass\n\n\nmain()\n',
      `Create function stays below the shebang and the coding line (${J(cookie)})`);
    const commented = await create('#!/usr/bin/env python3\n# type: ignore\n# start here\nmain()\n');
    check(commented === '#!/usr/bin/env python3\n# type: ignore\n\ndef main():\n    pass\n\n\n# start here\nmain()\n',
      `a file-level pragma stays on top, the comment over the call stays with it (${J(commented)})`);
  }

  // ---------- Add method ----------
  {
    const P = project({});
    const file = P('shapes.py');
    const text = 'class Square:\n    def __init__(self, side):\n        self.side = side\n\n    def describe(self):\n        return self.perimeter(self.side, unit="cm")\n\n\nprint(Square(2).describe())\n';
    const fixes = await fixesAt(file, text, at(text, 'perimeter'), [{ code: 'reportAttributeAccessIssue', range: range(text, 'perimeter') }]);
    check(fixes.length === 1 && fixes[0].kind === 'addMethod' && fixes[0].owner?.name === 'Square' && fixes[0].owner.line === 1, `self.perimeter() offers Add method to class Square (${J(fixes)})`);
    const r = await apply(file, text, fixes[0]);
    check(newText(r, file) === 'class Square:\n    def __init__(self, side):\n        self.side = side\n\n    def describe(self):\n        return self.perimeter(self.side, unit="cm")\n\n    def perimeter(self, side, unit):\n        pass\n\n\nprint(Square(2).describe())\n',
      `the method goes at the end of the class with the call's arguments (${J(newText(r, file))})`);
    check(r.result.place.line === 9, 'the caret goes to its pass');
  }
  {
    const P = project({ 'geo/model.py': 'class Box:\n    """A box."""\n    pass\n' });
    const file = P('use.py');
    const model = P('geo/model.py');
    const text = 'from geo.model import Box\n\nb = Box()\nb.resize(3)\n';
    const fixes = await fixesAt(file, text, at(text, 'resize'), [{ code: 'reportAttributeAccessIssue', range: range(text, 'resize') }]);
    check(fixes.length === 1 && fixes[0].receiver && J(fixes[0].receiver) === J({ line: 4, col: 1 }), `another receiver asks the IDE to resolve its class (${J(fixes)})`);
    const r = await apply(file, text, { ...fixes[0], owner: { path: model, line: 1, name: 'Box' } });
    check(newText(r, model) === 'class Box:\n    """A box."""\n    def resize(self, param):\n        pass\n', `the method replaces the pass of a class in another file, docstring kept (${J(newText(r, model))})`);
    check(!r.result.changes.some((c) => c.path === file), 'the calling file is not changed');
  }

  // ---------- Convert to f-string literal ----------
  {
    const P = project({});
    const file = P('fmt.py');
    const cases = [
      ['"Hello %s, you are %d" % (name, age)', 'f"Hello {name}, you are {age:d}"'],
      ["'%-10s|%5.2f|%r|%%|%05d|%+x' % (a, b, c, d, e)", "f'{a!s:<10}|{b:5.2f}|{c!r}|%|{d:05d}|{e:+x}'"],
      ["'%(user)s has %(n)i' % {'user': u, 'n': n}", "f'{u} has {n:d}'"],
      ['"{} and {}".format(a, b)', 'f"{a} and {b}"'],
      ['"{1}{0}{1}".format(x, y)', 'f"{y}{x}{y}"'],
      ['"{name!r:>8} {{literal}}".format(name=user.name)', 'f"{user.name!r:>8} {{literal}}"'],
      ['"{0.real} {0[1]}".format(z)', 'f"{z.real} {z[1]}"'],
      ['"{}".format(a + b)', 'f"{a + b}"'],
      ['"{}".format({1: 2})', 'f"{({1: 2})}"'],
      ['r"\\d+ %s" % pattern', 'fr"\\d+ {pattern}"'],
      ["'{}'.format(d['k'])", `f"{d['k']}"`],
      ['"%(a)s-%(a)s" % {"a": x}', 'f"{x}-{x}"'],
      ['"{} {}".format(x, f())', 'f"{x} {f()}"'],
      ['"{0}{0}{1}".format(o.x, f())', 'f"{o.x}{o.x}{f()}"'],
      ['"{}".format(1, x)', 'f"{1}"'],
      ["'\\x7b%s' % a", "f'\\x7b{a}'"],
    ];
    for (const [src, want] of cases) {
      const text = `v = ${src}\n`;
      const fixes = await fixesAt(file, text, { line: 1, col: 6 });
      const r = fixes.some((f) => f.kind === 'fstring') ? await apply(file, text, fixes.find((f) => f.kind === 'fstring')) : null;
      check(newText(r || {}, file) === `v = ${want}\n`, `${src} -> ${want} (${J(newText(r || {}, file))})`);
    }
    const refused = [
      '"%s %s" % (a,)', '"%*d" % (w, n)', '"{}{}".format(f())', '"{0}{}".format(a, b)', '"{x}".format(**kw)',
      '"%(a)s" % mapping', 'b"%s" % x', '"a" "b %s" % x', '"{:{w}}".format(a, w=3)', '"{0}{0}".format(f())',
      // Each would evaluate differently as an f-string: a call twice, a dropped side effect, calls in another order,
      // a read moved after a call, escapes that make braces or % signs.
      "'%(a)s-%(a)s' % {'a': next(it)}", "'%(a)s' % {'a': 1, 'b': calls.append(1)}", "'%(a)s' % {'a': f(), 'a': g()}",
      "'{}'.format(1, calls.append(1))", "'{0}'.format(1, k=log())", "'{1}{0}'.format(a(), b())", "'{1}{0}'.format(a, b())",
      "'{0.x}{1}{0.x}'.format(o, f())", "'{}\\x7d\\x7d'.format(5)", "'\\x7b0\\x7d'.format(5)", "'\\u007b\\u007d'.format()", "'%s\\x25s' % (a,)", "'\\N{BULLET} {}'.format(a)",
    ];
    for (const src of refused) {
      const text = `v = ${src}\n`;
      const fixes = await fixesAt(file, text, { line: 1, col: 6 });
      check(!fixes.some((f) => f.kind === 'fstring'), `not offered for ${src}`);
    }
    const none = await fixesAt(file, 'v = "plain"\n', { line: 1, col: 6 });
    check(!none.length, 'nothing offered on a plain string');
  }

  // ---------- Override / Implement Methods ----------
  {
    const P = project({
      'base.py': 'from abc import ABC, abstractmethod\n\n\nclass Shape(ABC):\n    @abstractmethod\n    def area(self) -> float:\n        ...\n\n    def describe(self, prefix: str = "") -> str:\n        return prefix\n\n    @property\n    def label(self) -> Label:\n        return "s"\n\n    def todo(self, *args, flag=False, **kw):\n        raise NotImplementedError\n\n    def __hidden(self):\n        pass\n\n    @staticmethod\n    def make(n):\n        return n\n\n    async def load(self, x, /, y):\n        return x\n',
    });
    const file = P('square.py');
    const text = 'from base import Shape\n\n\nclass Square(Shape):\n    def describe(self, prefix=""):\n        return "sq"\n';
    const entry = await call('classEntry', { file, pos: at(text, 'return'), overlay: { [file]: text } });
    check(J(entry.result) === J({ name: 'Square', line: 4, col: 7 }), `classEntry finds the class around the caret (${J(entry)})`);
    const classes = [{ path: file, line: 4, name: 'Square', module: 'square', bases: [1] }, { path: P('base.py'), line: 4, name: 'Shape', module: 'base', bases: [] }];
    const fixes = await fixesAt(file, text, at(text, 'Square', 2));
    check(fixes.some((f) => f.kind === 'implementAbstract' && f.name === 'Square'), 'the class header offers Implement abstract methods');
    const members = (await call('classMembers', { file, classes, overlay: { [file]: text } })).result.methods;
    const names = members.map((m) => m.name);
    check(J(members.filter((m) => m.abstract).map((m) => m.name)) === J(['area', 'todo']), `abstract: @abstractmethod and raise NotImplementedError (${J(members.filter((m) => m.abstract))})`);
    check(!names.includes('describe') && !names.includes('__hidden') && names.includes('__init__') && names.includes('__repr__') && names.indexOf('area') < names.indexOf('__init__'),
      `override candidates skip overridden and private methods and end with object's (${J(names)})`);
    check(members.find((m) => m.name === 'area').signature === 'area(self) -> float' && members.find((m) => m.name === 'label').signature === 'label(self)',
      `signatures keep annotations the module can name and drop the others (${J(members.map((m) => m.signature))})`);
    const impl = await call('insertMethods', { file, pos: at(text, 'class Square'), classes, names: ['area', 'todo'], mode: 'implement', overlay: { [file]: text } });
    check(newText(impl, file) === 'from base import Shape\n\n\nclass Square(Shape):\n    def describe(self, prefix=""):\n        return "sq"\n\n    def area(self) -> float:\n        pass\n\n    def todo(self, *args, flag=False, **kw):\n        pass\n',
      `Implement Methods writes pass bodies at the end of the class (${J(newText(impl, file))})`);
    check(J(impl.result.place) === J({ path: file, line: 9, col: 9, select: true }), `the caret selects the first pass (${J(impl.result.place)})`);
    const over = await call('insertMethods', { file, pos: at(text, 'return "sq"'), classes, names: ['label', 'make', 'load', '__init__', '__new__'], mode: 'override', overlay: { [file]: text } });
    const got = newText(over, file);
    check(got && got.includes('    @property\n    def label(self):\n        return super().label\n')
      && got.includes('    @staticmethod\n    def make(n):\n        return Shape.make(n)\n')
      && got.includes('    async def load(self, x, /, y):\n        return await super().load(x, y)\n')
      && got.includes('    def __init__(self) -> None:\n        super().__init__()\n')
      && got.includes('    def __new__(cls):\n        return super().__new__(cls)\n'), `Override Methods calls super() as PyCharm does (${J(got)})`);
    const bare = 'class Plain:\n    pass\n';
    const objOnly = (await call('classMembers', { file: P('plain.py'), classes: [{ path: P('plain.py'), line: 1, name: 'Plain', module: 'plain', bases: [] }], overlay: { [P('plain.py')]: bare } })).result.methods;
    check(objOnly.length > 10 && objOnly.every((m) => m.owner === 'object' && !m.abstract), 'a class without bases can override object\'s methods');
    const rep = await call('insertMethods', { file: P('plain.py'), pos: { line: 1, col: 3 }, classes: [{ path: P('plain.py'), line: 1, name: 'Plain', bases: [] }], names: ['__repr__'], mode: 'override', overlay: { [P('plain.py')]: bare } });
    check(newText(rep, P('plain.py')) === 'class Plain:\n    def __repr__(self) -> str:\n        return super().__repr__()\n', `a body of only pass is replaced (${J(newText(rep, P('plain.py')))})`);
    const outside = await call('classEntry', { file, pos: { line: 1, col: 1 }, overlay: { [file]: text } });
    check(outside.error?.code === 'no-class', 'outside a class: no-class');
  }
  {
    // Diamond: D(B, C), B(A), C(A); C overrides A.run, so C3 gives D B C A and run comes from C (not abstract).
    const P = project({
      'm.py': 'from abc import ABC, abstractmethod\n\n\nclass A(ABC):\n    @abstractmethod\n    def run(self): ...\n\n\nclass B(A):\n    pass\n\n\nclass C(A):\n    def run(self):\n        return 1\n\n\nclass D(B, C):\n    pass\n',
    });
    const file = P('m.py');
    const classes = [{ path: file, line: 18, name: 'D', bases: [1, 2] }, { path: file, line: 9, name: 'B', bases: [3] }, { path: file, line: 13, name: 'C', bases: [3] }, { path: file, line: 4, name: 'A', bases: [] }];
    const members = (await call('classMembers', { file, classes })).result.methods;
    const run = members.find((m) => m.name === 'run');
    check(run && run.owner === 'C' && !run.abstract, `the MRO is C3: run comes from C, so nothing is left to implement (${J(run)})`);
  }
  {
    // Defaults are evaluated when the def runs: a name the target module lacks is imported the way the base module
    // has it (as PyCharm does); a name no import can reach (a class attribute) becomes `...`.
    const P = project({
      'consts.py': 'LIMIT = 7\n',
      'base.py': 'import os\nfrom consts import LIMIT as CAP\n\nDEFAULT_TIMEOUT = 5\n\n\nclass Base:\n    RETRIES = 3\n\n    def connect(self, timeout=DEFAULT_TIMEOUT, sep=os.sep, cap=CAP, retries=RETRIES, n=1):\n        return (timeout, sep, cap, n)\n',
    });
    const file = P('m.py');
    const text = 'from base import Base\n\n\nclass Sub(Base):\n    pass\n';
    const classes = [{ path: file, line: 4, name: 'Sub', module: 'm', bases: [1] }, { path: P('base.py'), line: 7, name: 'Base', module: 'base', bases: [] }];
    const members = (await call('classMembers', { root: path.dirname(file), file, classes, overlay: { [file]: text } })).result.methods;
    const sig = members.find((m) => m.name === 'connect')?.signature;
    check(sig === 'connect(self, timeout=DEFAULT_TIMEOUT, sep=os.sep, cap=CAP, retries=..., n=1)', `the chooser shows the defaults as they will be written (${J(sig)})`);
    const r = await call('insertMethods', { root: path.dirname(file), file, pos: at(text, 'class Sub'), classes, names: ['connect'], mode: 'override', overlay: { [file]: text } });
    const got = newText(r, file);
    check(got === 'from base import Base, DEFAULT_TIMEOUT\nimport os\nfrom consts import LIMIT as CAP\n\n\nclass Sub(Base):\n    def connect(self, timeout=DEFAULT_TIMEOUT, sep=os.sep, cap=CAP, retries=..., n=1):\n        return super().connect(timeout, sep, cap, retries, n)\n',
      `Override imports the names its defaults use (${J(got ?? r.error)})`);
    check(r.result?.place?.line === 8, `the caret still lands on the super call (${J(r.result?.place)})`);
    writeFileSync(file, got || '');
    const run = spawnSync(PYTHON, [...PY_ARGS, '-c', 'import m; print(m.Sub().connect())'], { cwd: path.dirname(file), encoding: 'utf8', windowsHide: true });
    check(run.status === 0 && run.stdout.trim() === `(5, '${path.sep === '\\' ? '\\\\' : '/'}', 7, 1)`, `the generated module imports and its defaults reach the base (${J(run.stdout.trim() || run.stderr.trim())})`);
  }
  {
    // A project opened through an 8.3 short path: the nested paths (a fix's owner, the class graph) are matched to the
    // unsaved text too, and the result comes back in the IDE's spelling.
    const P = project({ 'long folder name/shapes.py': 'class Square:\n    pass\n' });
    const longDir = path.dirname(P('long folder name/shapes.py'));
    const short = execFileSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDir}').ShortPath`], { encoding: 'utf8', windowsHide: true }).trim();
    if (!short.includes('~')) {
      console.log('SKIP 8.3 paths: no short name for the test folder');
    } else {
      const file = path.join(short, 'shapes.py');
      const text = 'class Square:\n    def area(self):\n        return self.side()\n';
      const r = await call('generate', { root: short, file, overlay: { [file]: text }, fix: { kind: 'addMethod', name: 'side', at: at(text, 'side'), owner: { path: file, line: 1, name: 'Square' } } });
      check(r.result?.changes.length === 1 && r.result.changes[0].path === file && r.result.changes[0].new.includes('    def side(self):\n        pass') && r.result.changes[0].new.includes('def area'),
        `8.3 project: Add method edits the unsaved text and answers in the short spelling (${J(r)})`);
      const cls = [{ path: file, line: 1, name: 'Square', bases: [] }];
      const m = await call('insertMethods', { root: short, file, pos: { line: 1, col: 1 }, overlay: { [file]: text }, classes: cls, names: ['__repr__'], mode: 'override' });
      check(m.result?.changes.length === 1 && m.result.changes[0].new.includes('def area') && m.result.changes[0].new.includes('__repr__'), `8.3 project: the class graph reads the unsaved text (${J(m.error || '')})`);
    }
  }
  {
    const P = project({});
    const file = P('broken.py');
    const r = await call('quickFixes', { file, pos: { line: 1, col: 1 }, diagnostics: [], overlay: { [file]: 'def f(:\n' } });
    check(J(r.result) === J({ fixes: [] }), 'a file with syntax errors offers nothing (no error)');
  }
} finally {
  proc.stdin.end();
  proc.kill();
  rmSync(root, { recursive: true, force: true });
}
if (stderr.trim()) console.log(stderr.trim());
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
