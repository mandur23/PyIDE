"""Reads Python files with `ast` and prints what a class diagram needs, one JSON line per file.

Run by main/features/diagrams.js in the project interpreter with -I (no user site, no script or working directory on
sys.path), so nothing from the project can shadow a standard module. User code is only parsed, never imported or run.

stdin: a JSON list of {"path": str, "text"?: str} (text: an unsaved editor buffer to read instead of the file).
stdout: {"path", "ok": true, "info": {...}} or {"path", "ok": false, "error": str} per file, then {"done": true}.
"""
import ast
import json
import sys
import time

CONTAINERS = {
    'list', 'List', 'set', 'Set', 'frozenset', 'FrozenSet', 'tuple', 'Tuple', 'dict', 'Dict', 'Sequence',
    'MutableSequence', 'Iterable', 'Iterator', 'Collection', 'Mapping', 'MutableMapping', 'MutableSet', 'AbstractSet',
    'deque', 'Deque', 'DefaultDict', 'defaultdict', 'OrderedDict', 'Generator', 'AsyncIterator', 'AsyncIterable',
}
DATACLASS_DECORATORS = {'dataclass', 'define', 'frozen', 'mutable', 'attrs', 's'}
MAX_TEXT = 80


def dotted(node):
    """'a.b.C' for Name/Attribute chains (the value of a subscript such as Generic[T]); None otherwise."""
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Call):
        node = node.func
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def text_of(node):
    if node is None:
        return None
    try:
        s = ast.unparse(node)  # Python 3.9+
    except Exception:
        s = dotted(node) or '…'
    s = ' '.join(s.split())
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT - 1] + '…'


def type_refs(node, many=False, out=None):
    """Names an annotation mentions, with many=True inside a container (list[Shape], Dict[str, Shape])."""
    if out is None:
        out = []
    if node is None:
        return out
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            type_refs(ast.parse(node.value, mode='eval').body, many, out)
        except SyntaxError:
            pass
    elif isinstance(node, (ast.Name, ast.Attribute)):
        name = dotted(node)
        if name:
            out.append({'name': name, 'many': many})
    elif isinstance(node, ast.Subscript):
        outer = dotted(node.value) or ''
        inner_many = many or outer.split('.')[-1] in CONTAINERS
        if outer.split('.')[-1] not in ('Literal', 'Annotated'):
            type_refs(node.slice, inner_many, out)
        elif outer.split('.')[-1] == 'Annotated':
            sl = node.slice
            first = sl.elts[0] if isinstance(sl, ast.Tuple) and sl.elts else sl
            type_refs(first, many, out)
    elif isinstance(node, ast.Tuple):
        for e in node.elts:
            type_refs(e, many, out)
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        type_refs(node.left, many, out)
        type_refs(node.right, many, out)
    elif hasattr(ast, 'Index') and isinstance(node, getattr(ast, 'Index')):  # Python 3.8
        type_refs(node.value, many, out)
    return out


def is_classvar(ann):
    name = dotted(ann) or ''
    return name.split('.')[-1] == 'ClassVar'


def decorator_names(node):
    return [d for d in (dotted(x) for x in node.decorator_list) if d]


def params_text(fn):
    a = fn.args
    parts = []
    positional = list(getattr(a, 'posonlyargs', [])) + list(a.args)
    for i, arg in enumerate(positional):
        if i == 0 and arg.arg in ('self', 'cls'):
            continue
        parts.append(arg.arg + (': ' + text_of(arg.annotation) if arg.annotation is not None else ''))
    if a.vararg:
        parts.append('*' + a.vararg.arg)
    elif a.kwonlyargs:
        parts.append('*')
    for arg in a.kwonlyargs:
        parts.append(arg.arg + (': ' + text_of(arg.annotation) if arg.annotation is not None else ''))
    if a.kwarg:
        parts.append('**' + a.kwarg.arg)
    s = ', '.join(parts)
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT - 1] + '…'


def method_info(fn):
    decos = decorator_names(fn)
    last = [d.split('.')[-1] for d in decos]
    info = {
        'name': fn.name, 'line': fn.lineno, 'col': fn.col_offset + 1,
        'params': params_text(fn), 'returns': text_of(fn.returns),
        'async': isinstance(fn, ast.AsyncFunctionDef),
        'static': 'staticmethod' in last, 'classmethod': 'classmethod' in last,
        'property': any(x in ('property', 'cached_property') for x in last),
        'abstract': any(x.startswith('abstract') for x in last),
        'accessor': any(d.endswith(('.setter', '.deleter', '.getter')) for d in decos),
        'overload': 'overload' in last,
    }
    return info


def self_assignments(fn, fields, seen):
    """self.x = … and self.x: T = … inside a method body (not inside nested functions or classes)."""
    first = (list(getattr(fn.args, 'posonlyargs', [])) + list(fn.args.args))
    if not first:
        return
    self_name = first[0].arg
    param_types = {a.arg: a.annotation for a in fn.args.args + fn.args.kwonlyargs if a.annotation is not None}
    stack = list(fn.body)
    while stack:
        node = stack.pop(0)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        targets, ann, value = [], None, None
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign):
            targets, ann, value = [node.target], node.annotation, node.value
        for t in targets:
            for tt in (t.elts if isinstance(t, ast.Tuple) else [t]):
                if (isinstance(tt, ast.Attribute) and isinstance(tt.value, ast.Name) and tt.value.id == self_name
                        and tt.attr not in seen):
                    a = ann
                    # self.engine = engine with `engine: Engine` in the signature takes the parameter's type.
                    if a is None and isinstance(value, ast.Name) and value.id in param_types:
                        a = param_types[value.id]
                    seen.add(tt.attr)
                    fields.append({'name': tt.attr, 'type': text_of(a), 'refs': type_refs(a), 'kind': 'instance',
                                   'line': node.lineno})
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.stmt):
                stack.append(child)


def class_info(node, qual):
    decos = decorator_names(node)
    info = {
        'name': node.name, 'qualname': qual, 'line': node.lineno, 'col': node.col_offset + 1,
        'endLine': getattr(node, 'end_lineno', node.lineno),
        'bases': [dotted(b) for b in node.bases if dotted(b)],
        'metaclass': next((dotted(k.value) for k in node.keywords if k.arg == 'metaclass'), None),
        'decorators': decos,
        'dataclass': any(d.split('.')[-1] in DATACLASS_DECORATORS for d in decos),
        'fields': [], 'methods': [], 'nested': [],
    }
    seen = set()
    methods = {}
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            m = method_info(stmt)
            if m['accessor'] or m['overload'] and stmt.name in methods:
                continue
            if stmt.name in methods:  # a redefinition replaces the earlier one
                info['methods'] = [x for x in info['methods'] if x['name'] != stmt.name]
            methods[stmt.name] = m
            info['methods'].append(m)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            name = stmt.target.id
            if name in seen:
                continue
            seen.add(name)
            info['fields'].append({'name': name, 'type': text_of(stmt.annotation), 'refs': type_refs(stmt.annotation),
                                   'kind': 'classvar' if is_classvar(stmt.annotation) else 'annotated',
                                   'value': stmt.value is not None, 'line': stmt.lineno})
        elif isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                for tt in (t.elts if isinstance(t, ast.Tuple) else [t]):
                    if isinstance(tt, ast.Name) and tt.id not in seen and tt.id != '__slots__':
                        seen.add(tt.id)
                        info['fields'].append({'name': tt.id, 'type': None, 'refs': [], 'kind': 'class',
                                               'line': stmt.lineno})
        elif isinstance(stmt, ast.ClassDef):
            info['nested'].append(stmt)
    for name in ('__init__', '__post_init__'):
        fn = next((s for s in node.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == name), None)
        if fn is not None:
            self_assignments(fn, info['fields'], seen)
    return info


def module_info(tree):
    imports, classes = [], []

    def walk_block(body, conditional=False):
        for stmt in body:
            if isinstance(stmt, ast.Import):
                for a in stmt.names:
                    imports.append({'kind': 'import', 'module': a.name, 'as': a.asname})
            elif isinstance(stmt, ast.ImportFrom):
                imports.append({'kind': 'from', 'module': stmt.module or '', 'level': stmt.level or 0,
                                'names': [{'name': a.name, 'as': a.asname} for a in stmt.names]})
            elif isinstance(stmt, ast.ClassDef):
                add_class(stmt, stmt.name)
            elif isinstance(stmt, ast.If):
                walk_block(stmt.body, True)
                walk_block(stmt.orelse, True)
            elif isinstance(stmt, ast.Try) or type(stmt).__name__ == 'TryStar':
                walk_block(stmt.body, True)
                for h in stmt.handlers:
                    walk_block(h.body, True)
                walk_block(stmt.orelse, True)
                walk_block(stmt.finalbody, True)
            elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                # Module-level aliases (Alias = Shape) resolve like an import of the same module.
                target = dotted(stmt.value)
                if target and isinstance(stmt.value, (ast.Name, ast.Attribute)):
                    imports.append({'kind': 'alias', 'name': stmt.targets[0].id, 'target': target})

    def add_class(node, qual):
        info = class_info(node, qual)
        nested = info.pop('nested')
        classes.append(info)
        for n in nested:
            add_class(n, qual + '.' + n.name)

    walk_block(tree.body)
    return {'imports': imports, 'classes': classes}


def main():
    slow = 0.0
    if '--slow-ms' in sys.argv:
        slow = float(sys.argv[sys.argv.index('--slow-ms') + 1]) / 1000.0
    out = sys.stdout
    items = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    for item in items:
        path = item.get('path')
        try:
            if isinstance(item.get('text'), str):
                source = item['text']
            else:
                with open(path, 'rb') as f:
                    source = f.read()
            tree = ast.parse(source, filename=path or '<unknown>')
            msg = {'path': path, 'ok': True, 'info': module_info(tree)}
        except SyntaxError as e:
            msg = {'path': path, 'ok': False, 'error': 'SyntaxError: %s (line %s)' % (e.msg, e.lineno)}
        except Exception as e:  # unreadable file, recursion limit on absurd nesting, …
            msg = {'path': path, 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        out.write(json.dumps(msg, ensure_ascii=True) + '\n')
        out.flush()
        if slow:
            time.sleep(slow)
    out.write(json.dumps({'done': True}) + '\n')
    out.flush()


if __name__ == '__main__':
    main()
