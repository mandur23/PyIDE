"""Turns a Python file into a visual script graph (.pyflow) for the preview and for Convert to Visual Script.

Reads the source from stdin and prints one line: MARKER + {ok, graph, lines, statements, fallback} or {ok: false, error}.
The source is parsed with `ast` and never run.

A statement becomes nodes only when the graph's generated code does what the statement did; anything else stays as
written in a Python Code node, so a converted file runs as before. What the graph cannot hold the same way:
- Set Variable names are script variables (global), so a function's own variables become nodes only when no other
  scope uses those names and the function is not recursive; parameters and simple loop variables stay local.
- A loop's index is a generated local, so a loop variable is wired from the loop only when it is used inside the body
  alone; otherwise the body starts with Set Variable.
- Module-level code runs inside main(): a name a Python Code node binds there (import, def, class) is declared global
  first when a function made of nodes reads it or a `global` statement names it.
- input() and calls of functions made of nodes become steps of their own only when nothing with a side effect would
  then run in another order.
"""
import ast
import builtins
import io
import json
import keyword
import sys
import tokenize

MARKER = '@@PYIDE-VS@@'
# Names the generated code itself uses (codegen.js BUILTINS_USED).
RESERVED = {'print', 'input', 'str', 'int', 'float', 'len', 'range', 'RuntimeError', 'main'}
MATH_OPS = {ast.Add: '+', ast.Sub: '-', ast.Mult: '*', ast.Div: '/', ast.FloorDiv: '//', ast.Mod: '%', ast.Pow: '**'}
CMP_OPS = {ast.Eq: '==', ast.NotEq: '!=', ast.Lt: '<', ast.LtE: '<=', ast.Gt: '>', ast.GtE: '>='}
PURE_CALLS = {'str': ('convert.str', 'value'), 'int': ('convert.int', 'value'), 'float': ('convert.float', 'value'), 'len': ('list.len', 'list')}
OUT_TYPES = {
    'math.binary': 'number', 'math.compare': 'bool', 'math.and': 'bool', 'math.or': 'bool', 'math.not': 'bool',
    'math.negate': 'number', 'convert.str': 'string', 'convert.int': 'int', 'convert.float': 'number',
    'text.format': 'string', 'value.none': 'none', 'value.list': 'list', 'list.len': 'int', 'list.get': 'any',
    'var.get': 'any', 'py.expr': 'any', 'io.input': 'string', 'fn.call': 'any', 'py.call': 'any',
    'flow.forRange': 'int', 'flow.forEach': 'any', 'fn.define': 'any',
}
MAX_LIST = 32
SAFE_INT = 2 ** 53
NESTED = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
INDEX = getattr(ast, 'Index', None)  # Python 3.8 wraps a subscript's index


def unparse(src, e):
    if hasattr(ast, 'unparse'):
        return ast.unparse(e)
    return ' '.join(line.strip() for line in (ast.get_source_segment(src, e) or '').splitlines())


def own_nodes(fn):
    """The nodes of a function's own body, not those of the functions, classes and lambdas inside it."""
    stack = list(fn.body)
    while stack:
        n = stack.pop()
        yield n
        if not isinstance(n, NESTED):
            stack.extend(ast.iter_child_nodes(n))


def compatible(a, b):
    return a == b or a == 'any' or b == 'any' or (a == 'int' and b == 'number')


def ident(name):
    return name.isidentifier() and not keyword.iskeyword(name)


class Scope:
    """The names one scope (the module, or a top-level function) loads and stores, nested functions, classes, lambdas
    and comprehensions included as reads (they read the enclosing scope) but not as stores. The module's scope leaves
    out the bodies of its top-level functions, which have scopes of their own."""

    def __init__(self, body, params=(), module=False):
        self.loads = {}
        self.stores = {}
        self.globals = set()
        self.params = set(params)
        for stmt in body:
            if module and isinstance(stmt, ast.FunctionDef):
                self._add(self.stores, stmt.name, stmt)
                for d in stmt.decorator_list + stmt.args.defaults + [d for d in stmt.args.kw_defaults if d is not None]:
                    self._visit(d, inner=False)
                continue
            self._visit(stmt, inner=False)

    def _add(self, table, name, node):
        table.setdefault(name, []).append(node)

    def _visit(self, node, inner):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if not inner:
                self._add(self.stores, node.name, node)
            for d in node.decorator_list:
                self._visit(d, inner)
            if not isinstance(node, ast.ClassDef):
                for d in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                    self._visit(d, inner)
            for child in node.body:
                self._visit(child, True)
            return
        if isinstance(node, (ast.Import, ast.ImportFrom)) and not inner:
            for a in node.names:
                self._add(self.stores, (a.asname or a.name).split('.')[0], node)
            return
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            self.globals.update(node.names)
            return
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                self._add(self.loads, node.id, node)
            elif not inner:
                self._add(self.stores, node.id, node)
            return
        if isinstance(node, ast.ExceptHandler) and node.name and not inner:
            self._add(self.stores, node.name, node)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                self._visit_nested(child)
            else:
                self._visit(child, inner)

    def _visit_nested(self, node):
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                self._add(self.loads, child.id, child)

    def names(self):
        return set(self.loads) | set(self.stores)


def bound_inside(expr):
    """Names an expression binds for itself: comprehension targets, lambda parameters, := targets."""
    out = set()
    for n in ast.walk(expr):
        if isinstance(n, ast.comprehension):
            out.update(x.id for x in ast.walk(n.target) if isinstance(x, ast.Name))
        elif isinstance(n, ast.Lambda):
            a = n.args
            out.update(p.arg for p in a.posonlyargs + a.args + a.kwonlyargs)
            if a.vararg:
                out.add(a.vararg.arg)
            if a.kwarg:
                out.add(a.kwarg.arg)
        elif isinstance(n, ast.NamedExpr):
            out.add(n.target.id)
    return out


def float_literal(v):
    r = repr(v)
    return '.' in r and 'e' not in r and 'n' not in r and not r.endswith('.0')


class Converter:
    def __init__(self, source):
        self.src = source
        self.lines = source.splitlines(True)
        self.tree = ast.parse(source)
        self.nodes = []
        self.links = []
        self.ranges = {}
        self.seq = 0
        self.rows = []  # [kind, node id, depth]: the layout order
        self.children = {}  # pure node or step -> the pure nodes wired into it, in pin order
        self.statements = 0
        self.fallback = 0
        self.comments = self._comments()
        self._analyse()

    # ---------- analysis ----------
    def _analyse(self):
        body = self.tree.body
        self.module = Scope(body, module=True)
        self.functions = {}
        for s in body:
            if isinstance(s, ast.FunctionDef):
                a = s.args
                self.functions[s.name] = (s, Scope(s.body, [p.arg for p in a.posonlyargs + a.args + a.kwonlyargs]))
        all_globals = set(self.module.globals)
        for _, sc in self.functions.values():
            all_globals |= sc.globals
        self.declared_global = all_globals

        defs_seen = {}
        for s in body:
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs_seen[s.name] = defs_seen.get(s.name, 0) + 1
        candidates = {}
        for name, (fn, scope) in self.functions.items():
            if self._native_signature(fn) and defs_seen.get(name) == 1 and len(self.module.stores.get(name, [])) == 1:
                candidates[name] = (fn, scope)
        # Names stored by nodes in each candidate function, its simple loop variables, and which functions it calls.
        while True:
            native = set(candidates)
            info = {}
            for name, (fn, scope) in candidates.items():
                simple = self._simple_loops(fn.body, scope, native, module=False)
                stored = self._native_stores(fn.body, simple, native) - scope.params
                calls = {n for n in scope.loads if n in native}
                info[name] = (stored, calls)
            drop = set()
            for name, (fn, scope) in candidates.items():
                stored, _ = info[name]
                others = self.module.names()
                for other, (_, osc) in self.functions.items():
                    if other != name:
                        others |= (set(osc.loads) - osc.params) | set(osc.stores)
                if stored & (others | self.declared_global | native):
                    drop.add(name)
                    continue
                if stored and self._recursive(name, info):
                    drop.add(name)
                    continue
                if scope.params & native or any(name in osc.stores for _, osc in self.functions.values()):
                    drop.add(name)
            if not drop:
                break
            for d in drop:
                del candidates[d]
        self.native = set(candidates)
        self.module_simple = self._simple_loops(body, self.module, self.native, module=True)
        self.script_vars = self._native_stores(body, self.module_simple, self.native)
        self.fn_simple = {}
        for name, (fn, scope) in candidates.items():
            self.fn_simple[name] = self._simple_loops(fn.body, scope, self.native, module=False)
            self.script_vars |= self._native_stores(fn.body, self.fn_simple[name], self.native)
        native_reads = set()
        for name in self.native:
            native_reads |= set(self.functions[name][1].loads)
        wanted = (native_reads | self.declared_global) - self.script_vars - self.native - RESERVED - set(dir(builtins))
        self.globals_needed = sorted(wanted & set(self.module.stores))

    def _native_signature(self, fn):
        a = fn.args
        if fn.decorator_list or a.posonlyargs or a.kwonlyargs or a.vararg or a.kwarg or a.defaults:
            return False
        if not ident(fn.name) or fn.name in RESERVED:
            return False
        if any(not ident(p.arg) or p.arg in RESERVED for p in a.args):
            return False
        return not any(isinstance(n, (ast.Yield, ast.YieldFrom, ast.Await, ast.Global, ast.Nonlocal)) for n in own_nodes(fn))

    def _recursive(self, name, info):
        seen = set()
        stack = list(info[name][1])
        while stack:
            f = stack.pop()
            if f == name:
                return True
            if f in seen or f not in info:
                continue
            seen.add(f)
            stack.extend(info[f][1])
        return False

    def var_ok(self, name, native):
        return ident(name) and name not in RESERVED and name not in native

    def native_for(self, s, native):
        """A for statement that becomes a loop node (statement() decides the same)."""
        return isinstance(s, ast.For) and not s.orelse and isinstance(s.target, ast.Name) and self.var_ok(s.target.id, native)

    def _walk_body(self, body, native):
        """Statements of a body the converter turns into nodes (not inside a statement that stays Python Code)."""
        for s in body:
            yield s
            if isinstance(s, ast.If):
                yield from self._walk_body(s.body, native)
                yield from self._walk_body(s.orelse, native)
            elif (isinstance(s, ast.While) and not s.orelse) or self.native_for(s, native):
                yield from self._walk_body(s.body, native)

    def _native_stores(self, body, simple, native):
        out = set()
        for s in self._walk_body(body, native):
            if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
                n = s.targets[0].id
            elif isinstance(s, (ast.AugAssign, ast.AnnAssign)) and isinstance(s.target, ast.Name) and (not isinstance(s, ast.AnnAssign) or s.value is not None):
                n = s.target.id
                if isinstance(s, ast.AugAssign) and type(s.op) not in MATH_OPS:
                    continue
            elif self.native_for(s, native) and id(s) not in simple:
                n = s.target.id
            else:
                continue
            if self.var_ok(n, native):
                out.add(n)
        return out

    def _simple_loops(self, body, scope, native, module):
        """For loops (by id) whose target is used only inside the body and set nowhere else in the scope."""
        out = {}
        for s in self._walk_body(body, native):
            if not self.native_for(s, native):
                continue
            n = s.target.id
            if len(scope.stores.get(n, [])) != 1 or n in scope.params or n in self.declared_global:
                continue
            inside = {id(x) for b in s.body for x in ast.walk(b)}
            if any(id(x) not in inside for x in scope.loads.get(n, [])):
                continue
            if module and any(n in sc.names() for _, sc in self.functions.values()):
                continue
            out[id(s)] = n
        return out

    # ---------- graph ----------
    def add(self, kind, rng, props=None, inputs=None):
        self.seq += 1
        node = {'id': f'n{self.seq}', 'type': kind, 'x': 0, 'y': 0}
        if props:
            node['props'] = props
        if inputs:
            node['inputs'] = inputs
        self.nodes.append(node)
        if rng:
            self.ranges[node['id']] = rng
        return node

    def link(self, src, src_pin, dst, dst_pin):
        self.links.append({'from': {'node': src['id'], 'pin': src_pin}, 'to': {'node': dst['id'], 'pin': dst_pin}})

    def exec_link(self, prev, node):
        if prev:
            self.link(prev[0], prev[1], node, 'in')

    @staticmethod
    def rng(n):
        return [n.lineno, getattr(n, 'end_lineno', n.lineno) or n.lineno]

    def segment(self, node):
        first = min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])])
        start_col = node.col_offset if first == node.lineno else len(self.lines[first - 1]) - len(self.lines[first - 1].lstrip())
        end, end_col = node.end_lineno, node.end_col_offset
        chunk = self.lines[first - 1:end]
        if not chunk:
            return unparse(self.src, node)
        chunk[-1] = chunk[-1][:end_col] if len(chunk) > 1 else chunk[-1][:end_col]
        chunk[0] = ' ' * start_col + chunk[0][start_col:]
        return ''.join(chunk).rstrip()

    # ---------- expressions ----------
    # A source is ('lit', value) or ('pin', node, pin, type).
    def resolve(self, name, ctx):
        if name in ctx['loops']:
            node, pin = ctx['loops'][name]
            return ('pin', node, pin, OUT_TYPES[node['type']])
        if name in ctx['params']:
            return ('pin', ctx['params'][name], name, 'any')
        if name in self.script_vars:
            g = self.add('var.get', None, {'name': name})
            return ('pin', g, 'value', 'any')
        return None

    def py_expr(self, e, ctx):
        code = unparse(self.src, e)
        bound = bound_inside(e)
        names = []
        for n in ast.walk(e):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in bound and n.id not in names:
                if n.id in ctx['loops'] or n.id in ctx['params'] or n.id in self.script_vars:
                    names.append(n.id)
        node = self.add('py.expr', self.rng(e), {'code': code, 'inputs': ', '.join(names)})
        for name in names:
            src = self.resolve(name, ctx)
            self.connect(src, node, name)
        return ('pin', node, 'result', 'any')

    def connect(self, src, node, pin):
        if src[0] == 'lit':
            node.setdefault('inputs', {})[pin] = src[1]
            return
        self.link(src[1], src[2], node, pin)
        if src[1]['type'] in OUT_TYPES and src[1]['type'] not in ('fn.define', 'flow.forRange', 'flow.forEach', 'io.input', 'fn.call', 'py.call'):
            self.children.setdefault(node['id'], []).append(src[1]['id'])

    def feed(self, node, pin, want, e, ctx):
        src = self.expr(e, want, ctx)
        if src[0] == 'pin' and not compatible(src[3], want):
            src = self.py_expr(e, ctx)
        self.connect(src, node, pin)

    def literal(self, e, want, ctx):
        v = e.value
        if isinstance(v, bool):
            return ('lit', v) if want in ('bool', 'any') else None
        if isinstance(v, int):
            return ('lit', v) if want in ('number', 'int', 'any') and abs(v) <= SAFE_INT else None
        if isinstance(v, float):
            return ('lit', v) if want in ('number', 'any') and float_literal(v) else None
        if isinstance(v, str):
            return ('lit', v) if want in ('string', 'any') else None
        if v is None:
            return ('pin', self.add('value.none', self.rng(e)), 'value', 'none')
        return None

    def expr(self, e, want, ctx):
        if isinstance(e, ast.Constant):
            return self.literal(e, want, ctx) or self.py_expr(e, ctx)
        if isinstance(e, ast.Name):
            ctx['clean'] = False
            return self.resolve(e.id, ctx) or self.py_expr(e, ctx)
        if isinstance(e, ast.UnaryOp) and isinstance(e.op, ast.USub) and isinstance(e.operand, ast.Constant) \
                and type(e.operand.value) in (int, float) and want in ('number', 'int', 'any'):
            lit = self.literal(ast.Constant(-e.operand.value), want, ctx)
            if lit:
                return lit
        if isinstance(e, ast.BinOp) and type(e.op) in MATH_OPS:
            n = self.add('math.binary', self.rng(e), {'op': MATH_OPS[type(e.op)]})
            self.feed(n, 'a', 'number', e.left, ctx)
            self.feed(n, 'b', 'number', e.right, ctx)
            return ('pin', n, 'result', 'number')
        if isinstance(e, ast.Compare) and len(e.ops) == 1 and type(e.ops[0]) in CMP_OPS:
            n = self.add('math.compare', self.rng(e), {'op': CMP_OPS[type(e.ops[0])]})
            self.feed(n, 'a', 'any', e.left, ctx)
            self.feed(n, 'b', 'any', e.comparators[0], ctx)
            return ('pin', n, 'result', 'bool')
        if isinstance(e, ast.BoolOp):
            kind = 'math.and' if isinstance(e.op, ast.And) else 'math.or'
            lazy = ctx['lazy']
            ctx['lazy'] = True
            try:
                left = e.values[0]
                acc = None
                for right in e.values[1:]:
                    n = self.add(kind, self.rng(e))
                    if acc is None:
                        self.feed(n, 'a', 'bool', left, ctx)
                    else:
                        self.connect(acc, n, 'a')
                    self.feed(n, 'b', 'bool', right, ctx)
                    acc = ('pin', n, 'result', 'bool')
                return acc
            finally:
                ctx['lazy'] = lazy
        if isinstance(e, ast.UnaryOp) and isinstance(e.op, (ast.Not, ast.USub)):
            kind, pin_type = ('math.not', 'bool') if isinstance(e.op, ast.Not) else ('math.negate', 'number')
            n = self.add(kind, self.rng(e))
            self.feed(n, 'value', pin_type, e.operand, ctx)
            return ('pin', n, 'result', OUT_TYPES[kind])
        if isinstance(e, ast.Call):
            return self.call_expr(e, want, ctx)
        index = getattr(e, 'slice', None)
        if INDEX and isinstance(index, INDEX):
            index = index.value
        if isinstance(e, ast.Subscript) and isinstance(index, ast.expr) and not isinstance(index, (ast.Slice, ast.Tuple)) and isinstance(e.ctx, ast.Load):
            n = self.add('list.get', self.rng(e))
            self.feed(n, 'list', 'any', e.value, ctx)
            self.feed(n, 'index', 'number', index, ctx)
            return ('pin', n, 'item', 'any')
        if isinstance(e, ast.List) and len(e.elts) <= MAX_LIST and not any(isinstance(x, ast.Starred) for x in e.elts):
            n = self.add('value.list', self.rng(e), {'count': len(e.elts)})
            for i, x in enumerate(e.elts):
                self.feed(n, f'item{i}', 'any', x, ctx)
            return ('pin', n, 'list', 'list')
        if isinstance(e, ast.JoinedStr):
            fmt = self.format_text(e, ctx)
            if fmt:
                return fmt
        ctx['clean'] = False
        return self.py_expr(e, ctx)

    def format_text(self, e, ctx):
        parts = []
        fields = []
        for v in e.values:
            if isinstance(v, ast.Constant):
                parts.append(v.value.replace('{', '{{').replace('}', '}}'))
                continue
            if not isinstance(v, ast.FormattedValue) or not isinstance(v.value, ast.Name) or not ident(v.value.id):
                return None
            spec = ''
            if v.format_spec is not None:
                if not all(isinstance(x, ast.Constant) for x in v.format_spec.values):
                    return None
                spec = ''.join(x.value for x in v.format_spec.values)
                if '{' in spec or '}' in spec:
                    return None
            conv = {-1: '', 115: '!s', 114: '!r', 97: '!a'}[v.conversion]
            parts.append('{' + v.value.id + conv + (':' + spec if spec else '') + '}')
            if v.value.id not in fields:
                fields.append(v.value.id)
        n = self.add('text.format', self.rng(e), {'template': ''.join(parts)})
        for f in fields:
            ctx['clean'] = False
            first = next(v.value for v in e.values if isinstance(v, ast.FormattedValue) and v.value.id == f)
            src = self.resolve(f, ctx) or self.py_expr(first, ctx)
            self.connect(src, n, f)
        return ('pin', n, 'text', 'string')

    def plain_args(self, call):
        return not call.keywords and not any(isinstance(a, ast.Starred) for a in call.args)

    def hoistable(self, call, ctx):
        if ctx['lazy'] or not ctx['clean'] or not self.plain_args(call) or not isinstance(call.func, ast.Name):
            return False
        name = call.func.id
        if name == 'input':
            return len(call.args) <= 1 and 'input' not in self.module.stores
        return name in self.native and len(call.args) == len(self.functions[name][0].args.args)

    def call_expr(self, e, want, ctx):
        if self.hoistable(e, ctx):
            step = self.call_step(e, ctx)
            ctx['hoisted'].append(step)
            return ('pin', step, 'answer' if step['type'] == 'io.input' else 'result', OUT_TYPES[step['type']])
        f = e.func
        if isinstance(f, ast.Name) and f.id in PURE_CALLS and len(e.args) == 1 and self.plain_args(e) and f.id not in self.module.stores:
            kind, pin = PURE_CALLS[f.id]
            n = self.add(kind, self.rng(e))
            self.feed(n, pin, 'any', e.args[0], ctx)
            return ('pin', n, 'result' if kind != 'list.len' else 'length', OUT_TYPES[kind])
        ctx['clean'] = False
        return self.py_expr(e, ctx)

    def call_step(self, call, ctx):
        """io.input or fn.call for a call; its arguments are fed now, before the step runs."""
        name = call.func.id
        if name == 'input':
            n = self.add('io.input', self.rng(call))
            if call.args:
                self.feed(n, 'prompt', 'string', call.args[0], ctx)
            else:
                n.setdefault('inputs', {})['prompt'] = ''
            return n
        fn = self.functions[name][0]
        n = self.add('fn.call', self.rng(call), {'function': name})
        for p, a in zip(fn.args.args, call.args):
            self.feed(n, p.arg, 'any', a, ctx)
        return n

    # ---------- statements ----------
    def code_node(self, s, ctx):
        self.fallback += 1
        code = self.segment(s)
        bound = set()
        for n in ast.walk(s):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id in ctx['loops']:
                bound.add(n.id)
        names = sorted(bound)
        node = self.add('py.code', self.rng(s), {'code': code, 'inputs': ', '.join(names), 'outputs': ''})
        for name in names:
            self.connect(self.resolve(name, ctx), node, name)
        return node

    def row(self, node, depth):
        self.rows.append(['step', node['id'], depth])

    def comment_rows(self, after, before, depth):
        """The comment lines between two statements of a block, as one Comment node."""
        group = [(line, text) for line, text in self.comments if after < line < before]
        if group:
            node = self.add('ui.comment', [group[0][0], group[-1][0]], {'text': '\n'.join(t for _, t in group)})
            self.rows.append(['comment', node['id'], depth])

    def block(self, body, prev, ctx, depth, after):
        """Converts statements in order; returns the exec pin the next statement follows (None: flow ended)."""
        for s in body:
            first = min([s.lineno] + [d.lineno for d in getattr(s, 'decorator_list', [])])
            self.comment_rows(after, first, depth)
            prev = self.statement(s, prev, ctx, depth)
            after = s.end_lineno
        return prev

    def chain(self, steps, prev, depth):
        for st in steps:
            self.exec_link(prev, st)
            self.row(st, depth)
            prev = (st, 'next')
        return prev

    def statement(self, s, prev, ctx, depth):
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and depth == 0 and ctx['fn'] is None and s.name in self.native:
            return prev
        if isinstance(s, ast.Pass):
            return prev
        self.statements += 1
        if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str):
            node = self.add('ui.comment', self.rng(s), {'text': s.value.value.strip('\n')})
            self.rows.append(['comment', node['id'], depth])
            self.statements -= 1
            return prev
        ctx['clean'] = True
        ctx['lazy'] = False
        ctx['hoisted'] = []
        made = self.simple_statement(s, ctx)
        if made is not None:
            prev = self.chain(ctx['hoisted'], prev, depth)
            self.exec_link(prev, made)
            self.row(made, depth)
            if made['type'] in ('fn.return', 'flow.break', 'flow.continue'):
                return None
            return (made, 'next')
        if isinstance(s, ast.If):
            node = self.add('flow.if', self.rng(s))
            self.feed(node, 'cond', 'bool', s.test, ctx)
            prev = self.chain(ctx['hoisted'], prev, depth)
            self.exec_link(prev, node)
            self.row(node, depth)
            self.block(s.body, (node, 'then'), ctx, depth + 1, s.lineno)
            if s.orelse:
                self.block(s.orelse, (node, 'else'), ctx, depth + 1, s.body[-1].end_lineno)
            return (node, 'done')
        if isinstance(s, ast.While) and not s.orelse:
            ctx['lazy'] = True
            node = self.add('flow.while', self.rng(s))
            self.feed(node, 'cond', 'bool', s.test, ctx)
            self.exec_link(prev, node)
            self.row(node, depth)
            self.block(s.body, (node, 'body'), self.loop_ctx(ctx), depth + 1, s.lineno)
            return (node, 'done')
        if self.native_for(s, self.native):
            return self.for_loop(s, prev, ctx, depth)
        node = self.code_node(s, ctx)
        self.exec_link(prev, node)
        self.row(node, depth)
        return (node, 'next')

    def loop_ctx(self, ctx):
        return {**ctx, 'loops': dict(ctx['loops']), 'in_loop': True}

    def for_loop(self, s, prev, ctx, depth):
        it = s.iter
        is_range = isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == 'range' \
            and 'range' not in self.module.stores and 1 <= len(it.args) <= 3 and self.plain_args(it)
        if is_range:
            node = self.add('flow.forRange', self.rng(s))
            args = it.args
            pins = {1: ['stop'], 2: ['start', 'stop'], 3: ['start', 'stop', 'step']}[len(args)]
            for pin, a in zip(pins, args):
                self.feed(node, pin, 'number', a, ctx)
            if len(args) == 1:
                node.setdefault('inputs', {})['start'] = 0
            out = 'index'
        else:
            node = self.add('flow.forEach', self.rng(s))
            self.feed(node, 'list', 'list', it, ctx)
            out = 'item'
        prev = self.chain(ctx['hoisted'], prev, depth)
        self.exec_link(prev, node)
        self.row(node, depth)
        inner = self.loop_ctx(ctx)
        start = (node, 'body')
        name = s.target.id
        if id(s) in ctx['simple']:
            inner['loops'][name] = (node, out)
        else:
            inner['loops'].pop(name, None)
            setter = self.add('var.set', self.rng(s.target), {'name': name})
            self.link(node, out, setter, 'value')
            self.exec_link(start, setter)
            self.row(setter, depth + 1)
            start = (setter, 'next')
        self.block(s.body, start, inner, depth + 1, s.lineno)
        return (node, 'done')

    def simple_statement(self, s, ctx):
        """A step for an assignment, a call or a return, or None when the statement is not one of these."""
        native = self.native
        if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name) \
                and s.targets[0].id in self.script_vars and s.targets[0].id not in ctx['loops']:
            node = self.add('var.set', self.rng(s), {'name': s.targets[0].id})
            self.feed(node, 'value', 'any', s.value, ctx)
            return node
        if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name) and s.value is not None \
                and s.target.id in self.script_vars and s.target.id not in ctx['loops']:
            node = self.add('var.set', self.rng(s), {'name': s.target.id})
            self.feed(node, 'value', 'any', s.value, ctx)
            return node
        if isinstance(s, ast.AugAssign) and isinstance(s.target, ast.Name) and type(s.op) in MATH_OPS \
                and s.target.id in self.script_vars and s.target.id not in ctx['loops']:
            ctx['clean'] = False
            name = s.target.id
            node = self.add('var.set', self.rng(s), {'name': name})
            op = self.add('math.binary', self.rng(s), {'op': MATH_OPS[type(s.op)]})
            self.connect(self.resolve(name, ctx), op, 'a')
            self.feed(op, 'b', 'number', s.value, ctx)
            self.connect(('pin', op, 'result', 'number'), node, 'value')
            return node
        if isinstance(s, ast.Return) and ctx['fn'] is not None:
            node = self.add('fn.return', self.rng(s))
            if s.value is not None:
                self.feed(node, 'value', 'any', s.value, ctx)
            return node
        if isinstance(s, ast.Break) and ctx['in_loop']:
            return self.add('flow.break', self.rng(s))
        if isinstance(s, ast.Continue) and ctx['in_loop']:
            return self.add('flow.continue', self.rng(s))
        if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)):
            return None
        call = s.value
        f = call.func
        if not self.plain_args(call):
            return None
        if isinstance(f, ast.Name) and f.id == 'print' and 'print' not in self.module.stores:
            if len(call.args) <= 1:
                node = self.add('io.print', self.rng(s))
                if call.args:
                    self.feed(node, 'value', 'any', call.args[0], ctx)
                else:
                    node.setdefault('inputs', {})['value'] = ''
                return node
            if len(call.args) <= MAX_LIST:
                node = self.add('py.call', self.rng(s), {'module': '', 'function': 'print', 'count': len(call.args)})
                for i, a in enumerate(call.args):
                    self.feed(node, f'arg{i}', 'any', a, ctx)
                return node
            return None
        if isinstance(f, ast.Name) and (f.id == 'input' or f.id in native) and self.hoistable(call, ctx):
            return self.call_step(call, ctx)
        if isinstance(f, ast.Attribute) and f.attr == 'append' and len(call.args) == 1:
            node = self.add('list.append', self.rng(s))
            self.feed(node, 'list', 'list', f.value, ctx)
            self.feed(node, 'item', 'any', call.args[0], ctx)
            return node
        # Any other call of a name or a dotted name (bump(), math.sqrt(x), p.move(1)) is Call Python without a module.
        # A simple loop variable is named after its node in the generated code, so its calls stay Python Code.
        dotted = []
        while isinstance(f, ast.Attribute):
            dotted.insert(0, f.attr)
            f = f.value
        if isinstance(f, ast.Name) and f.id not in ctx['loops'] and len(call.args) <= MAX_LIST:
            node = self.add('py.call', self.rng(s), {'module': '', 'function': '.'.join([f.id] + dotted), 'count': len(call.args)})
            for i, a in enumerate(call.args):
                self.feed(node, f'arg{i}', 'any', a, ctx)
            return node
        return None

    # ---------- whole file ----------
    def _comments(self):
        out = []
        try:
            for tok in tokenize.generate_tokens(io.StringIO(self.src).readline):
                if tok.type == tokenize.COMMENT and not tok.line[:tok.start[1]].strip():
                    out.append((tok.start[0], tok.string[1:].strip()))
        except (tokenize.TokenError, IndentationError, SyntaxError):
            pass
        return out

    def run(self):
        start = self.add('core.start', None)
        self.rows.append(['step', start['id'], 0])
        prev = (start, 'next')
        if self.globals_needed:
            node = self.add('py.code', None, {'code': 'global ' + ', '.join(self.globals_needed), 'inputs': '', 'outputs': ''})
            self.exec_link(prev, node)
            self.row(node, 0)
            prev = (node, 'next')
        base = {'loops': {}, 'params': {}, 'fn': None, 'simple': self.module_simple, 'in_loop': False}
        self.block(self.tree.body, prev, base, 0, 0)
        self.comment_rows(self.tree.body[-1].end_lineno if self.tree.body else 0, 10 ** 9, 0)
        for s in self.tree.body:
            if isinstance(s, ast.FunctionDef) and s.name in self.native:
                self.rows.append(['section', None, 0])
                self.statements += 1
                params = [p.arg for p in s.args.args]
                node = self.add('fn.define', [s.lineno, s.lineno], {'name': s.name, 'params': ', '.join(params)})
                self.rows.append(['step', node['id'], 0])
                ctx = {'loops': {}, 'params': {p: node for p in params}, 'fn': s.name, 'simple': self.fn_simple[s.name], 'in_loop': False}
                self.block(s.body, (node, 'body'), ctx, 1, s.lineno)
        self.layout()
        return {'format': 1, 'nodes': self.nodes, 'links': self.links}

    # ---------- layout ----------
    def size(self, node):
        t = node['type']
        props = node.get('props', {})
        code = str(props.get('code', props.get('text', props.get('template', ''))))
        lines = code.split('\n') if code else []
        width = 230
        if lines:
            width = max(width, min(520, 7 * max(len(x) for x in lines) + 70))
        inputs = self.wired.get(node['id'], 0) + len(node.get('inputs', {}))
        rows = max(1, inputs, 3 if t in ('flow.if', 'flow.forRange') else 2 if t.startswith('flow.') else 1)
        height = 40 + rows * 26 + (min(8, len(lines)) * 17 if t in ('py.code', 'py.expr', 'ui.comment') else 0)
        if t in ('var.set', 'var.get', 'fn.call', 'py.call', 'math.binary', 'math.compare', 'fn.define', 'text.format'):
            height += 26
        return width, height

    def layout(self):
        self.wired = {}
        for lk in self.links:
            if lk['to']['pin'] != 'in':
                self.wired[lk['to']['node']] = self.wired.get(lk['to']['node'], 0) + 1
        by_id = {n['id']: n for n in self.nodes}
        indent = 300
        gap = 28
        y = 0
        placed = set()

        def tree(nid, right, top):
            node = by_id[nid]
            w, h = self.size(node)
            node['x'], node['y'] = right - w - 40, top
            placed.add(nid)
            used = 0
            for c in self.children.get(nid, []):
                if c in placed:
                    continue
                used += tree(c, node['x'], top + used) + 12
            return max(h, used - 12 if used else 0)

        for kind, nid, depth in self.rows:
            if kind == 'section':
                y += 80
                continue
            node = by_id[nid]
            w, h = self.size(node)
            node['x'], node['y'] = depth * indent, y
            placed.add(nid)
            used = 0
            for c in self.children.get(nid, []):
                if c in placed:
                    continue
                used += tree(c, node['x'], y + used) + 12
            y += max(h, used - 12 if used else 0) + gap
        for n in self.nodes:
            if n['id'] not in placed:
                n['x'], n['y'] = -260, y
                y += self.size(n)[1] + gap
        min_x = min(n['x'] for n in self.nodes)
        for n in self.nodes:
            n['x'] = int(round((n['x'] - min_x + 80) / 16) * 16)
            n['y'] = int(round((n['y'] + 80) / 16) * 16)


def main():
    source = sys.stdin.read()
    try:
        conv = Converter(source)
    except SyntaxError as err:
        print(MARKER + json.dumps({'ok': False, 'error': {'message': err.msg, 'line': err.lineno or 1, 'col': err.offset or 1}}))
        return
    graph = conv.run()
    print(MARKER + json.dumps({'ok': True, 'graph': graph, 'lines': conv.ranges, 'statements': conv.statements, 'fallback': conv.fallback}, ensure_ascii=False))


if __name__ == '__main__':
    main()
