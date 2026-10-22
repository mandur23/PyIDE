"""Semantic highlighting for Python from the syntax tree and its scopes.

Classifies the names of a module by what they bind to: parameters, self/cls, classes, functions and methods,
properties, modules, constants, builtins, decorators and type parameters. Names imported from other modules are
resolved by reading (never importing or running) that module's source or stub: the project, typeshed's standard
library stubs, then the interpreter's sys.path. A little inference follows instances of classes it can see
(constructor calls, annotations, return annotations), and an attribute of an unknown object is a method when it is
called and a property otherwise.

JSON lines on stdin/stdout: {"id", "method": "tokens", "params": {"text", "path", "root", "stubs": [dirs]}}
-> {"id", "result": {"data": [deltaLine, deltaStart, length, type, modifiers, ...]}} (LSP semantic tokens).
"""
import ast
import builtins
import json
import os
import re
import sys
import time

TYPES = ['namespace', 'class', 'typeParameter', 'parameter', 'selfParameter', 'clsParameter', 'variable',
         'property', 'function', 'method', 'decorator']
MODS = ['declaration', 'readonly', 'defaultLibrary']
T = {n: i for i, n in enumerate(TYPES)}
M = {n: 1 << i for i, n in enumerate(MODS)}
CONST = re.compile(r'^_*[A-Z][A-Z0-9_]*$')
PROPERTY_DECOS = {'property', 'cached_property', 'abstractproperty', 'classproperty'}
TYPEVAR_CALLS = {'TypeVar', 'ParamSpec', 'TypeVarTuple'}
CLASSLIKE_ANNOTATIONS = {'_SpecialForm', 'TypeAlias', 'TypeAliasType'}
PY312 = sys.version_info >= (3, 12)
MAX_DEPTH = 6
MISS_TTL = 10  # seconds a module that was not found stays not found (a file created later is seen after it)


def deco_name(d):
    if isinstance(d, ast.Call):
        d = d.func
    if isinstance(d, ast.Name):
        return d.id
    if isinstance(d, ast.Attribute):
        return d.attr
    return ''


def all_params(a):
    return a.posonlyargs + a.args + ([a.vararg] if a.vararg else []) + a.kwonlyargs + ([a.kwarg] if a.kwarg else [])


def resolve_relative(node, pkg):
    if not node.level:
        return node.module or ''
    parts = pkg.split('.') if pkg else []
    if node.level - 1 > len(parts):
        return ''
    base = parts[:len(parts) - (node.level - 1)]
    if node.module:
        base.append(node.module)
    return '.'.join(base)


# ---------------------------------------------------------------- other modules, from their source or stubs

class Info:
    """What a module-level name is: kind ('class', 'function', 'variable', 'constant', 'namespace',
    'typeParameter'), and for a class its members and bases (names in its module)."""
    __slots__ = ('kind', 'members', 'bases', 'module', 'target')

    def __init__(self, kind, members=None, bases=(), module='', target=None):
        self.kind, self.members, self.bases, self.module, self.target = kind, members, tuple(bases), module, target


def class_summary(node):
    members = {}
    for st in node.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            decos = {deco_name(d) for d in st.decorator_list}
            prop = decos & PROPERTY_DECOS or any(isinstance(d, ast.Attribute) and d.attr in ('setter', 'getter', 'deleter') for d in st.decorator_list)
            members.setdefault(st.name, 'property' if prop else 'method')
            if st.name == '__init__':
                for n in ast.walk(st):
                    if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store) and isinstance(n.value, ast.Name) and n.value.id == 'self':
                        members.setdefault(n.attr, 'property')
        elif isinstance(st, ast.ClassDef):
            members[st.name] = 'class'
        elif isinstance(st, (ast.Assign, ast.AnnAssign)):
            for t in (st.targets if isinstance(st, ast.Assign) else [st.target]):
                if isinstance(t, ast.Name):
                    members.setdefault(t.id, 'constant' if CONST.match(t.id) else 'property')
    bases = []
    for b in node.bases:
        if isinstance(b, ast.Subscript):
            b = b.value
        if isinstance(b, ast.Name):
            bases.append(b.id)
        elif isinstance(b, ast.Attribute) and isinstance(b.value, ast.Name):
            bases.append(f'{b.value.id}.{b.attr}')
    return members, bases


_SEARCH_PATHS = None


def search_paths():
    """The folders the interpreter would import from, in its order, without this script's folder. The sidecar runs
    isolated (-I), so PYTHONPATH and the user site-packages are not on sys.path; they are added back here because
    modules are only read from them, never imported."""
    global _SEARCH_PATHS
    if _SEARCH_PATHS is None:
        here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
        own = [p for p in sys.path if p and os.path.normcase(os.path.abspath(p)) != here]
        extra = [p for p in os.environ.get('PYTHONPATH', '').split(os.pathsep) if p]
        user = None
        try:
            import site
            user = site.getusersitepackages()
        except Exception:  # noqa: BLE001 - an embedded Python without site
            pass
        if user and user not in own:
            at = next((i for i, p in enumerate(own) if os.path.basename(p.rstrip('\\/')).lower() == 'site-packages'), len(own))
            own.insert(at, user)
        _SEARCH_PATHS = []
        for p in extra + own:
            if p not in _SEARCH_PATHS:
                _SEARCH_PATHS.append(p)
    return [p for p in _SEARCH_PATHS if os.path.isdir(p)]


class Modules:
    def __init__(self):
        self.cache = {}  # file -> (mtime, names, generation it was last checked in)
        self.found = {}
        self.paths = []
        self.gen = 0

    def configure(self, root, stubs):
        self.gen += 1
        paths = ([root] if root else []) + [s for s in (stubs or []) if s and os.path.isdir(s)]
        paths += [p for p in search_paths() if p not in paths]
        if paths != self.paths:
            self.paths = paths
            self.found = {}

    def find(self, dotted):
        if not dotted:
            return None
        hit = self.found.get(dotted)
        if hit is not None and (hit[0] or time.monotonic() - hit[1] < MISS_TTL):
            return hit[0]
        parts = dotted.split('.')
        hit = None
        for base in self.paths:
            d = os.path.join(base, *parts)
            for f in (d + '.pyi', d + '.py', os.path.join(d, '__init__.pyi'), os.path.join(d, '__init__.py')):
                if os.path.isfile(f):
                    hit = f
                    break
            if hit:
                break
            if os.path.isdir(d) and not any(os.path.isfile(os.path.join(base, *parts[:i], '__init__.py')) for i in range(1, len(parts))):
                hit = d  # a namespace package
                break
        self.found[dotted] = (hit, time.monotonic())
        return hit

    def is_module(self, dotted):
        return self.find(dotted) is not None

    def names(self, dotted, depth=0):
        """{name: Info} of a module's top level."""
        f = self.find(dotted)
        if not f:
            return {}
        hit = self.cache.get(f)
        if hit and hit[2] == self.gen:
            return hit[1]  # checked during this request
        try:
            st = os.stat(f)
        except OSError:
            return {}
        if not os.path.isfile(f):
            return {}
        if hit and hit[0] == st.st_mtime:
            self.cache[f] = (hit[0], hit[1], self.gen)
            return hit[1]
        out = {}
        self.cache[f] = (st.st_mtime, out, self.gen)  # set first: guards import cycles
        try:
            with open(f, 'rb') as fh:
                tree = ast.parse(fh.read())
        except Exception:  # noqa: BLE001 - a module that does not parse just stays unknown
            return out
        pkg = dotted if os.path.basename(f).startswith('__init__.') else dotted.rpartition('.')[0]
        self.collect(tree.body, dotted, pkg, out)
        return out

    def collect(self, body, dotted, pkg, out):
        for node in body:
            if isinstance(node, ast.ClassDef):
                members, bases = class_summary(node)
                out.setdefault(node.name, Info('class', members, bases, dotted))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.setdefault(node.name, Info('function', module=dotted))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                ann = getattr(node, 'annotation', None)
                for t in targets:
                    if not isinstance(t, ast.Name):
                        continue
                    if isinstance(node.value, ast.Call) and deco_name(node.value) in TYPEVAR_CALLS:
                        info = Info('typeParameter')
                    elif ann is not None and ((isinstance(ann, ast.Subscript) and isinstance(ann.value, ast.Name) and ann.value.id == 'type') or (isinstance(ann, ast.Name) and ann.id in CLASSLIKE_ANNOTATIONS)):
                        info = Info('class', {}, (), dotted)
                    elif isinstance(node.value, (ast.Name, ast.Attribute)) and not CONST.match(t.id):
                        info = Info('alias', module=dotted, target=node.value)  # X = Y: whatever Y is
                    else:
                        info = Info('constant' if CONST.match(t.id) else 'variable')
                    out.setdefault(t.id, info)
            elif isinstance(node, ast.ImportFrom):
                mod = resolve_relative(node, pkg)
                for a in node.names:
                    if a.name != '*' and (a.asname or a.name) not in out:
                        out[a.asname or a.name] = Info('imported', module=mod, target=a.name)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    name = a.asname or a.name.partition('.')[0]
                    out.setdefault(name, Info('namespace', module=a.name if a.asname else name))
            elif isinstance(node, (ast.If, ast.Try)) or type(node).__name__ == 'TryStar':
                self.collect(node.body, dotted, pkg, out)
                self.collect(getattr(node, 'orelse', []), dotted, pkg, out)
                self.collect(getattr(node, 'finalbody', []), dotted, pkg, out)
                for h in getattr(node, 'handlers', []):
                    self.collect(h.body, dotted, pkg, out)
            elif PY312 and isinstance(node, ast.TypeAlias):
                out.setdefault(node.name.id, Info('class', {}, (), dotted))

    def lookup(self, dotted, name, depth=0):
        """Info of `name` in module `dotted`, following re-exports and aliases."""
        if depth > MAX_DEPTH:
            return None
        info = self.names(dotted).get(name)
        if info is None:
            return Info('namespace', module=f'{dotted}.{name}') if self.is_module(f'{dotted}.{name}') else None
        if info.kind == 'imported':
            if self.is_module(f'{info.module}.{info.target}'):
                return Info('namespace', module=f'{info.module}.{info.target}')
            return self.lookup(info.module, info.target, depth + 1)
        if info.kind == 'alias':
            v = info.target
            if isinstance(v, ast.Name):
                return self.lookup(dotted, v.id, depth + 1) if v.id != name else None
            if isinstance(v, ast.Attribute) and isinstance(v.value, ast.Name):
                base = self.lookup(dotted, v.value.id, depth + 1)
                if base and base.kind == 'namespace':
                    return self.lookup(base.module, v.attr, depth + 1)
            return Info('variable')
        return info

    def class_member(self, info, attr, depth=0, seen=None):
        """Kind of `attr` on an imported class, through its bases."""
        if info is None or info.kind != 'class' or depth > MAX_DEPTH:
            return None
        seen = seen or set()
        key = (info.module, id(info))
        if key in seen:
            return None
        seen.add(key)
        if info.members and attr in info.members:
            return info.members[attr]
        for b in info.bases:
            base_info = self.base_info(info.module, b, depth)
            k = self.class_member(base_info, attr, depth + 1, seen)
            if k:
                return k
        return None

    def base_info(self, module, base, depth=0):
        if '.' in base:
            head, _, attr = base.partition('.')
            m = self.lookup(module, head, depth + 1)
            return self.lookup(m.module, attr, depth + 1) if m and m.kind == 'namespace' else None
        return self.lookup(module, base, depth + 1)


MODULES = Modules()
BUILTINS = None


def builtins_info(name):
    """Info of a builtin from typeshed's builtins.pyi when available, else from the running interpreter."""
    global BUILTINS
    if BUILTINS is None:
        BUILTINS = MODULES.names('builtins') or {}
    info = BUILTINS.get(name)
    if info is not None and info.kind in ('class', 'function'):
        return info
    if info is not None and info.kind in ('variable', 'constant', 'alias'):
        return Info('variable')
    v = getattr(builtins, name, None)
    if v is None and name not in ('__name__', '__file__', '__doc__', '__spec__', '__package__', '__loader__', '__debug__', '__builtins__'):
        return None
    if isinstance(v, type):
        return Info('class', {n: ('method' if callable(getattr(v, n, None)) else 'property') for n in dir(v)}, (), 'builtins')
    return Info('function' if callable(v) else 'variable', module='builtins')


# ---------------------------------------------------------------- this module

class Binding:
    __slots__ = ('kind', 'mods', 'scope', 'cls', 'info', 'node')

    def __init__(self, kind, mods=(), scope=None, cls=None, info=None, node=None):
        self.kind, self.mods, self.scope, self.cls, self.info, self.node = kind, tuple(mods), scope, cls, info, node


class Scope:
    def __init__(self, kind, node, parent):
        self.kind, self.node, self.parent = kind, node, parent
        self.names = {}
        self.globals, self.nonlocals = set(), set()
        self.instance = {}
        self.bases = []
        self.types = {}  # local name -> how to find the class of its value

    def bind(self, name, b):
        if name in self.globals:
            self.module_scope().names.setdefault(name, b)
            return
        old = self.names.get(name)
        if old is None or (old.kind == 'variable' and b.kind != 'variable'):
            self.names[name] = b

    def module_scope(self):
        s = self
        while s.parent:
            s = s.parent
        return s


class Analyzer:
    def __init__(self, text, module_name='', is_package=False):
        self.text = text
        self.lines = text.split('\n')
        try:
            self.tree = ast.parse(text)
        except ValueError as e:  # NUL bytes
            raise SyntaxError(str(e)) from None
        self.module_name = module_name
        self.pkg = module_name if is_package else module_name.rpartition('.')[0]
        self.scopes = {}
        self.tokens = {}
        self.decorator_nodes = set()

    # ---------- positions
    def col16(self, line, col8):
        s = self.lines[line - 1] if 0 < line <= len(self.lines) else ''
        if s.isascii():
            return col8
        prefix = s.encode('utf-8')[:col8].decode('utf-8', 'replace')
        return len(prefix) + sum(1 for ch in prefix if ord(ch) > 0xFFFF)

    def emit(self, line, col8, name, kind, mods=()):
        if kind not in T or line < 1 or line > len(self.lines):
            return
        raw = self.lines[line - 1].encode('utf-8')
        if raw[col8:col8 + len(name.encode('utf-8'))].decode('utf-8', 'replace') != name:
            return  # the node's position does not hold its name (a line continuation, an old f-string)
        bits = 0
        for m in mods:
            bits |= M.get(m, 0)
        n = len(name) + sum(1 for ch in name if ord(ch) > 0xFFFF)
        self.tokens[(line - 1, self.col16(line, col8))] = (n, T[kind], bits)

    def name_after(self, node, keyword):
        line = self.lines[node.lineno - 1] if node.lineno - 1 < len(self.lines) else ''
        m = re.compile(rb'\b' + keyword + rb'\s+([^\s(:\[]+)').search(line.encode('utf-8'), node.col_offset)
        if m and m.group(1).decode('utf-8', 'replace') == node.name:
            return node.lineno, m.start(1)
        return None

    # ---------- pass 1: scopes and bindings
    def build(self):
        self.module = Scope('module', self.tree, None)
        self.scopes[self.tree] = self.module
        self.visit_body(self.tree.body, self.module)

    def visit_body(self, body, scope):
        for st in body:
            self.bind_stmt(st, scope)

    def first_param(self, node, scope):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or scope.kind != 'class':
            return None
        if any(deco_name(d) == 'staticmethod' for d in node.decorator_list):
            return None
        args = node.args.posonlyargs + node.args.args
        return args[0] if args else None

    def bind_target(self, t, scope, value=None, annotation=None):
        if isinstance(t, ast.Name):
            kind, mods = 'variable', ()
            if scope.kind in ('module', 'class') and CONST.match(t.id):
                mods = ('readonly',)
            if isinstance(value, ast.Call) and deco_name(value) in TYPEVAR_CALLS and scope.kind != 'function':
                kind, mods = 'typeParameter', ()
            elif scope.kind == 'class':
                kind = 'property'
            scope.bind(t.id, Binding(kind, mods, scope, node=t))
            if annotation is not None:
                scope.types.setdefault(t.id, ('ann', annotation, scope.parent if scope.kind == 'class' else scope))
            elif value is not None and scope.kind != 'class':
                scope.types.setdefault(t.id, ('value', value, scope))
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                self.bind_target(e, scope)
        elif isinstance(t, ast.Starred):
            self.bind_target(t.value, scope)
        elif isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and scope.kind == 'function':
            owner = scope.parent
            first = self.first_param(scope.node, owner) if owner else None
            if first is not None and t.value.id == first.arg:
                owner.instance.setdefault(t.attr, Binding('property', (), owner))
                if annotation is not None:
                    owner.types.setdefault(t.attr, ('ann', annotation, owner.parent))
                elif value is not None:
                    owner.types.setdefault(t.attr, ('value', value, scope))

    def bind_stmt(self, st, scope):
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            decos = {deco_name(d) for d in st.decorator_list}
            if scope.kind == 'class':
                prop = decos & PROPERTY_DECOS or any(isinstance(d, ast.Attribute) and d.attr in ('setter', 'getter', 'deleter') for d in st.decorator_list)
                kind = 'property' if prop else 'method'
            else:
                kind = 'function'
            inner = Scope('function', st, scope)
            self.scopes[st] = inner
            if not (scope.kind == 'class' and st.name in scope.names and scope.names[st.name].kind == 'property'):
                scope.bind(st.name, Binding(kind, (), scope, cls=inner, node=st))
            for tp in getattr(st, 'type_params', None) or []:
                inner.bind(tp.name, Binding('typeParameter', (), inner))
            first = self.first_param(st, scope)
            cls_first = first is not None and ('classmethod' in decos or st.name in ('__new__', '__init_subclass__', '__class_getitem__') or
                                               any(isinstance(b, ast.Name) and b.id == 'type' for b in getattr(scope.node, 'bases', [])))
            for p in all_params(st.args):
                k = 'parameter'
                if p is first:
                    k = 'clsParameter' if cls_first else 'selfParameter'
                inner.bind(p.arg, Binding(k, (), inner, node=p))
                if k == 'parameter' and p.annotation is not None:
                    inner.types[p.arg] = ('ann', p.annotation, scope)
            self.visit_body(st.body, inner)
            self.scan_exprs([*st.decorator_list, *st.args.defaults, *[d for d in st.args.kw_defaults if d is not None]], scope)
        elif isinstance(st, ast.ClassDef):
            inner = Scope('class', st, scope)
            self.scopes[st] = inner
            inner.bases = list(st.bases)
            scope.bind(st.name, Binding('class', (), scope, cls=inner, node=st))
            for tp in getattr(st, 'type_params', None) or []:
                inner.bind(tp.name, Binding('typeParameter', (), inner))
            self.visit_body(st.body, inner)
            self.scan_exprs([*st.decorator_list, *st.bases], scope)
        elif isinstance(st, ast.Import):
            for a in st.names:
                if a.asname:
                    scope.bind(a.asname, Binding('namespace', (), scope, info=Info('namespace', module=a.name)))
                else:
                    top = a.name.partition('.')[0]
                    scope.bind(top, Binding('namespace', (), scope, info=Info('namespace', module=top)))
        elif isinstance(st, ast.ImportFrom):
            mod = resolve_relative(st, self.pkg)
            for a in st.names:
                if a.name != '*':
                    scope.bind(a.asname or a.name, Binding('imported', (), scope, info=Info('imported', module=mod, target=a.name)))
        elif isinstance(st, ast.Assign):
            for t in st.targets:
                self.bind_target(t, scope, st.value)
            self.scan_exprs([st.value], scope)
        elif isinstance(st, ast.AnnAssign):
            self.bind_target(st.target, scope, st.value, st.annotation)
            self.scan_exprs([st.value] if st.value else [], scope)
        elif isinstance(st, ast.AugAssign):
            self.bind_target(st.target, scope)
            self.scan_exprs([st.value], scope)
        elif isinstance(st, (ast.For, ast.AsyncFor)):
            self.bind_target(st.target, scope)
            self.scan_exprs([st.iter], scope)
            self.visit_body(st.body + st.orelse, scope)
        elif isinstance(st, (ast.With, ast.AsyncWith)):
            for it in st.items:
                if it.optional_vars is not None:
                    self.bind_target(it.optional_vars, scope, it.context_expr if isinstance(it.context_expr, ast.Call) else None)
                self.scan_exprs([it.context_expr], scope)
            self.visit_body(st.body, scope)
        elif isinstance(st, ast.Global):
            scope.globals.update(st.names)
        elif isinstance(st, ast.Nonlocal):
            scope.nonlocals.update(st.names)
        elif PY312 and isinstance(st, ast.TypeAlias):
            scope.bind(st.name.id, Binding('class', (), scope))
        else:
            for field in ('body', 'orelse', 'finalbody', 'handlers', 'cases'):
                part = getattr(st, field, None)
                if not isinstance(part, list):
                    continue
                for n in part:
                    if isinstance(n, ast.ExceptHandler):
                        if n.name:
                            scope.bind(n.name, Binding('variable', (), scope))
                        self.visit_body(n.body, scope)
                    elif type(n).__name__ == 'match_case':
                        for p in ast.walk(n.pattern):
                            name = getattr(p, 'name', None)
                            if isinstance(name, str):
                                scope.bind(name, Binding('variable', (), scope))
                        self.visit_body(n.body, scope)
                    elif isinstance(n, ast.stmt):
                        self.bind_stmt(n, scope)
            self.scan_exprs([getattr(st, f) for f in ('test', 'subject', 'value', 'exc') if isinstance(getattr(st, f, None), ast.AST)], scope)

    def scan_exprs(self, nodes, scope):
        """Scopes of lambdas and comprehensions, and walrus targets, inside expressions."""
        stack = [(n, scope) for n in nodes if n is not None]
        while stack:
            n, sc = stack.pop()
            if isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):
                s = sc
                while s.kind == 'comprehension':
                    s = s.parent
                s.bind(n.target.id, Binding('variable', (), s))
            if isinstance(n, ast.Lambda):
                inner = Scope('function', n, sc)
                self.scopes[n] = inner
                for p in all_params(n.args):
                    inner.bind(p.arg, Binding('parameter', (), inner))
                stack.append((n.body, inner))
                continue
            if isinstance(n, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                inner = Scope('comprehension', n, sc)
                self.scopes[n] = inner
                for g in n.generators:
                    self.bind_target(g.target, inner)
                for child in ast.iter_child_nodes(n):
                    stack.append((child, inner))
                continue
            for child in ast.iter_child_nodes(n):
                stack.append((child, sc))

    # ---------- name resolution
    def lookup(self, name, scope):
        s, first = scope, True
        while s is not None:
            if name in s.globals:
                return s.module_scope().names.get(name)
            if (first or s.kind != 'class') and name in s.names:
                return s.names[name]
            first = False
            s = s.parent
        return None

    def info_of(self, b):
        """Info of an imported binding (resolved through the other module)."""
        if b.info is None:
            return None
        if b.info.kind == 'imported':
            if MODULES.is_module(f'{b.info.module}.{b.info.target}'):
                return Info('namespace', module=f'{b.info.module}.{b.info.target}')
            return MODULES.lookup(b.info.module, b.info.target)
        return b.info

    def kind_of(self, b):
        if b.kind == 'imported':
            info = self.info_of(b)
            return info_kind(info)
        return b.kind, b.mods

    # ---------- a little type inference: a value's class, here (a Scope) or elsewhere (an Info)
    def class_of_expr(self, e, scope, depth=0):
        if depth > MAX_DEPTH or e is None:
            return None
        if isinstance(e, ast.Constant) and isinstance(e.value, str):
            try:
                e = ast.parse(e.value, mode='eval').body
            except SyntaxError:
                return None
        if isinstance(e, ast.Name):
            b = self.lookup(e.id, scope)
            if b is None:
                info = builtins_info(e.id)
                return info if info is not None and info.kind == 'class' else None
            if b.kind == 'class':
                return b.cls
            if b.kind == 'imported':
                info = self.info_of(b)
                return info if info is not None and info.kind == 'class' else None
            return None
        if isinstance(e, ast.Attribute):
            m = self.module_of(e.value, scope)
            if m:
                info = MODULES.lookup(m, e.attr)
                return info if info is not None and info.kind == 'class' else None
        if isinstance(e, ast.Subscript):
            return self.class_of_expr(e.value, scope, depth + 1)
        return None

    def instance_of(self, e, scope, depth=0):
        """The class of the object an expression evaluates to, when it can be seen."""
        if depth > MAX_DEPTH:
            return None
        if isinstance(e, ast.Name):
            b = self.lookup(e.id, scope)
            if b is None:
                return None
            if b.kind in ('selfParameter', 'clsParameter'):
                s = b.scope.parent
                return s if s is not None and s.kind == 'class' else None
            t = b.scope.types.get(e.id) if b.scope is not None else None
            return self.type_from(t, depth)
        if isinstance(e, ast.Call):
            f = e.func
            cls = self.class_of_expr(f, scope, depth + 1)
            if cls is not None:
                return cls
            if isinstance(f, ast.Name):
                b = self.lookup(f.id, scope)
                if b is not None and b.kind == 'function' and isinstance(b.cls, Scope) and isinstance(b.cls.node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    return self.class_of_expr(b.cls.node.returns, b.scope, depth + 1)
            if isinstance(f, ast.Attribute):
                owner = self.class_of_expr(f.value, scope, depth + 1) or self.instance_of(f.value, scope, depth + 1)
                if isinstance(owner, Scope):
                    m = self.member(owner, f.attr)
                    if m is not None and isinstance(m.cls, Scope) and isinstance(m.cls.node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        return self.class_of_expr(m.cls.node.returns, owner.parent, depth + 1)
            return None
        if isinstance(e, ast.Attribute):
            owner = self.instance_of(e.value, scope, depth + 1)
            if isinstance(owner, Scope):
                s = owner
                for _ in range(MAX_DEPTH):
                    if e.attr in s.types:
                        return self.type_from(s.types[e.attr], depth + 1)
                    break
        return None

    def type_from(self, t, depth):
        if not t:
            return None
        how, node, scope = t
        if how == 'ann':
            return self.class_of_expr(node, scope, depth + 1)
        return self.instance_of(node, scope, depth + 1)

    def member(self, cls_scope, attr, seen=None):
        """A member of a class in this file: its body, its instance attributes, then its bases."""
        seen = seen or set()
        if cls_scope is None or id(cls_scope) in seen:
            return None
        seen.add(id(cls_scope))
        if attr in cls_scope.names:
            return cls_scope.names[attr]
        if attr in cls_scope.instance:
            return cls_scope.instance[attr]
        for base in cls_scope.bases:
            c = self.class_of_expr(base, cls_scope.parent)
            if isinstance(c, Scope):
                found = self.member(c, attr, seen)
                if found is not None:
                    return found
            elif isinstance(c, Info):
                k = MODULES.class_member(c, attr)
                if k:
                    return Binding(*info_kind(Info(k)))
        return None

    def module_of(self, e, scope):
        """Dotted module name an expression names (os, os.path, a package's submodule), or None."""
        if isinstance(e, ast.Name):
            b = self.lookup(e.id, scope)
            if b is None:
                return None
            info = self.info_of(b) if b.kind in ('namespace', 'imported') else None
            return info.module if info is not None and info.kind == 'namespace' else None
        if isinstance(e, ast.Attribute):
            base = self.module_of(e.value, scope)
            if base:
                info = MODULES.lookup(base, e.attr)
                return info.module if info is not None and info.kind == 'namespace' else None
        return None

    # ---------- pass 2: tokens
    def run(self):
        self.build()
        self.walk(self.tree, self.module)
        out = []
        pl = pc = 0
        for (line, col) in sorted(self.tokens):
            n, t, m = self.tokens[(line, col)]
            out += [line - pl, col - pc if line == pl else col, n, t, m]
            pl, pc = line, col
        return out

    def walk(self, root, scope):
        stack = [(root, scope, False)]
        while stack:
            node, sc, in_ann = stack.pop()
            if isinstance(node, ast.JoinedStr) and not PY312:
                continue
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.emit_def(node, sc)
                inner = self.scopes.get(node, sc)
                for d in node.decorator_list:
                    self.emit_decorator(d)
                    stack.append((d, sc, False))
                for tp in getattr(node, 'type_params', None) or []:
                    self.emit(tp.lineno, tp.col_offset, tp.name, 'typeParameter', ('declaration',))
                    for f in ('bound', 'default_value'):
                        if getattr(tp, f, None) is not None:
                            stack.append((getattr(tp, f), inner, True))
                if isinstance(node, ast.ClassDef):
                    hdr = inner if getattr(node, 'type_params', None) else sc
                    for e in node.bases:
                        stack.append((e, hdr, False))
                    for k in node.keywords:
                        stack.append((k.value, hdr, False))
                    for st in node.body:
                        stack.append((st, inner, False))
                else:
                    a = node.args
                    for p in all_params(a):
                        b = inner.names.get(p.arg)
                        self.emit(p.lineno, p.col_offset, p.arg, b.kind if b and b.kind in ('selfParameter', 'clsParameter') else 'parameter', ('declaration',))
                        if p.annotation is not None:
                            stack.append((p.annotation, inner, True))
                    for dflt in a.defaults + [d for d in a.kw_defaults if d is not None]:
                        stack.append((dflt, sc, False))
                    if node.returns is not None:
                        stack.append((node.returns, inner, True))
                    for st in node.body:
                        stack.append((st, inner, False))
                continue
            if isinstance(node, ast.Lambda):
                inner = self.scopes.get(node, sc)
                for p in all_params(node.args):
                    self.emit(p.lineno, p.col_offset, p.arg, 'parameter', ('declaration',))
                stack.append((node.body, inner, False))
                for dflt in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                    stack.append((dflt, sc, False))
                continue
            if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                inner = self.scopes.get(node, sc)
                for i, g in enumerate(node.generators):
                    stack.append((g.iter, sc if i == 0 else inner, False))
                    stack.append((g.target, inner, False))
                    for c in g.ifs:
                        stack.append((c, inner, False))
                for f in ('elt', 'key', 'value'):
                    v = getattr(node, f, None)
                    if v is not None:
                        stack.append((v, inner, False))
                continue
            if isinstance(node, ast.Name):
                self.emit_name(node, sc)
                continue
            if isinstance(node, ast.Attribute):
                self.emit_attribute(node, sc)
                stack.append((node.value, sc, in_ann))
                continue
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self.emit_import(node, sc)
                continue
            if isinstance(node, ast.keyword):
                if node.arg and hasattr(node, 'lineno'):
                    self.emit(node.lineno, node.col_offset, node.arg, 'parameter')
                stack.append((node.value, sc, False))
                continue
            if isinstance(node, ast.AnnAssign):
                stack.append((node.annotation, sc, True))
                stack.append((node.target, sc, False))
                if node.value is not None:
                    stack.append((node.value, sc, False))
                continue
            if in_ann and isinstance(node, ast.Constant) and isinstance(node.value, str):
                self.emit_string_annotation(node, sc)
                continue
            if PY312 and isinstance(node, ast.TypeAlias):
                self.emit(node.name.lineno, node.name.col_offset, node.name.id, 'class', ('declaration',))
                stack.append((node.value, sc, True))
                continue
            for child in ast.iter_child_nodes(node):
                stack.append((child, sc, in_ann))

    def emit_string_annotation(self, node, sc):
        """A forward reference such as "Point" in an annotation."""
        if node.lineno != node.end_lineno:
            return
        raw = self.lines[node.lineno - 1].encode('utf-8')[node.col_offset:node.end_col_offset]
        m = re.match(rb'^[rRbBuU]?(["\'])([A-Za-z_][\w.]*)\1$', raw)
        if not m:
            return
        name = m.group(2).decode()
        head = name.split('.')[0]
        b = self.lookup(head, sc)
        if b is not None and '.' not in name:
            kind, mods = self.kind_of(b)
            if kind:
                self.emit(node.lineno, node.col_offset + m.start(2), name, kind, mods)

    def emit_def(self, node, sc):
        pos = self.name_after(node, rb'class' if isinstance(node, ast.ClassDef) else rb'def')
        if not pos:
            return
        if isinstance(node, ast.ClassDef):
            kind = 'class'
        else:
            b = sc.names.get(node.name)
            kind = 'function' if sc.kind != 'class' else (b.kind if b is not None and b.kind in ('method', 'property') else 'method')
        self.emit(pos[0], pos[1], node.name, kind, ('declaration',))

    def emit_decorator(self, d):
        f = d.func if isinstance(d, ast.Call) else d
        raw = self.lines[f.lineno - 1].encode('utf-8') if f.lineno - 1 < len(self.lines) else b''
        at = raw.rfind(b'@', 0, f.col_offset + 1)
        if at >= 0 and raw[at + 1:f.col_offset].strip() == b'':
            self.emit(f.lineno, at, '@', 'decorator')
        if isinstance(f, ast.Name):
            self.emit(f.lineno, f.col_offset, f.id, 'decorator')
            self.decorator_nodes.add(id(f))
        elif isinstance(f, ast.Attribute) and f.end_lineno == f.lineno:
            self.emit(f.end_lineno, f.end_col_offset - len(f.attr.encode('utf-8')), f.attr, 'decorator')
            self.decorator_nodes.add(id(f))

    def emit_name(self, node, sc):
        if id(node) in self.decorator_nodes:
            return
        b = self.lookup(node.id, sc)
        if b is None:
            if node.id in ('True', 'False', 'None', 'NotImplemented', 'Ellipsis', 'self', 'cls'):
                return
            info = builtins_info(node.id)
            if info is not None:
                self.emit(node.lineno, node.col_offset, node.id, info.kind if info.kind in ('class', 'function') else 'variable', ('defaultLibrary',))
            return
        kind, mods = self.kind_of(b)
        if kind:
            self.emit(node.lineno, node.col_offset, node.id, kind, mods)

    def emit_attribute(self, node, sc):
        if id(node) in self.decorator_nodes or node.end_lineno is None:
            return
        line, col = node.end_lineno, node.end_col_offset - len(node.attr.encode('utf-8'))
        mod = self.module_of(node.value, sc)
        if mod:
            kind, mods = info_kind(MODULES.lookup(mod, node.attr))
            if kind:
                self.emit(line, col, node.attr, kind, mods)
            return
        owner = self.class_of_expr(node.value, sc) or self.instance_of(node.value, sc)
        kind = mods = None
        if isinstance(owner, Scope):
            m = self.member(owner, node.attr)
            if m is not None:
                kind, mods = self.kind_of(m)
        elif isinstance(owner, Info):
            k = MODULES.class_member(owner, node.attr)
            if k:
                kind, mods = info_kind(Info(k))
        if kind is None:
            kind, mods = ('method', ()) if self.is_called(node) else ('property', ())
        if kind == 'variable':
            kind = 'property'
        self.emit(line, col, node.attr, kind, mods or ())

    def is_called(self, node):
        return id(node) in self.callees

    def emit_import(self, node, sc):
        for a in node.names:
            if a.name == '*' or not hasattr(a, 'lineno'):
                continue
            if isinstance(node, ast.Import):
                c = a.col_offset
                for p in a.name.split('.'):
                    self.emit(a.lineno, c, p, 'namespace')
                    c += len(p.encode('utf-8')) + 1
                if a.asname:
                    self.emit_asname(a, 'namespace', ())
            else:
                b = sc.names.get(a.asname or a.name)
                kind, mods = self.kind_of(b) if b is not None else (None, ())
                if kind:
                    self.emit(a.lineno, a.col_offset, a.name, kind, mods)
                    if a.asname:
                        self.emit_asname(a, kind, mods)
        if isinstance(node, ast.ImportFrom) and node.module:
            raw = self.lines[node.lineno - 1].encode('utf-8') if node.lineno - 1 < len(self.lines) else b''
            m = re.compile(rb'from\s+\.*').match(raw, node.col_offset)
            if m:
                c = m.end()
                for p in node.module.split('.'):
                    self.emit(node.lineno, c, p, 'namespace')
                    c += len(p.encode('utf-8')) + 1

    def emit_asname(self, a, kind, mods):
        if getattr(a, 'end_lineno', None) == a.lineno:
            self.emit(a.end_lineno, a.end_col_offset - len(a.asname.encode('utf-8')), a.asname, kind, mods)


def info_kind(info):
    if info is None:
        return None, ()
    k = info.kind
    if k == 'constant':
        return 'variable', ('readonly',)
    if k in ('class', 'function', 'namespace', 'typeParameter', 'variable', 'property', 'method'):
        return k, ()
    return None, ()


def tokens(text, path='', root='', stubs=None):
    MODULES.configure(root, stubs)
    module_name = ''
    if path and root:
        try:
            rel = os.path.relpath(path, root)
        except ValueError:  # another drive
            rel = '..'
        if not rel.startswith('..'):
            module_name = os.path.splitext(rel)[0].replace(os.sep, '.').replace('/', '.')
    is_package = os.path.basename(path).startswith('__init__.')
    if module_name.endswith('.__init__') or module_name == '__init__':
        module_name = module_name[:-9].rstrip('.')
    an = Analyzer(text, module_name, is_package)
    an.callees = {id(n.func) for n in ast.walk(an.tree) if isinstance(n, ast.Call)}
    return an.run()


def main():
    sys.stdin.reconfigure(encoding='utf-8', errors='surrogateescape')
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid, method, params = req.get('id'), req.get('method'), req.get('params') or {}
        try:
            if method == 'hello':
                result = {'ok': sys.version_info >= (3, 8), 'version': sys.version.split()[0]}
            elif method == 'tokens':
                result = {'data': tokens(params.get('text', ''), params.get('path', ''), params.get('root', ''), params.get('stubs'))}
            elif method == 'legend':
                result = {'tokenTypes': TYPES, 'tokenModifiers': MODS}
            else:
                result = None
            out = {'id': rid, 'result': result}
        except SyntaxError as e:
            out = {'id': rid, 'error': {'code': 'syntax', 'message': str(e)}}
        except Exception as e:  # noqa: BLE001 - reported to the IDE, which keeps the last tokens
            out = {'id': rid, 'error': {'code': 'internal', 'message': f'{type(e).__name__}: {e}'}}
        sys.stdout.write(json.dumps(out) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
