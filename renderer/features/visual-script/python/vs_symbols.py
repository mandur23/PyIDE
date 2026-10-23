"""The functions and classes a visual script can call, for the node palette. Run by main/features/visual-script.js in
the project interpreter with -I (no user site, no script or working directory on sys.path, PYTHON* variables ignored).

  project          stdin: {"files": [{"path", "module"}], "seconds": float}. Reads each file with `ast` only: user
                   code is never imported or run. Prints one JSON line per file, then {"done": true, "truncated": bool}.
  module NAME ROOT Imports NAME (standard library or site-packages only: a module that resolves inside ROOT, the
                   project folder, is refused before anything is imported) and describes it with `inspect`.
                   Prints one line: MARKER + {"ok": true, "module": {...}} or {"ok": false, "reason", "error"}.
  packages ROOT    The top-level modules that can be imported, without importing any. MARKER + {"ok", "packages"}.

A module: {"name", "doc", "functions": [fn], "classes": [cls], "submodules"?: [names]}
fn:  {"name", "params": [param], "returns": str|null, "doc": str, "async": bool}
cls: {"name", "params": [param] (the constructor's, without self), "doc", "methods": [fn + {"kind": "method"|"static"|"class"}]}
param: {"name", "kind": "positional"|"positional-only"|"keyword-only"|"var-positional"|"var-keyword",
        "default": source text|null, "annotation": source text|null}
"""
import ast
import json
import os
import sys
import time

MARKER = '@@PYIDE-VS@@'
MAX_TEXT = 200
MAX_MEMBERS = 600
MAX_METHODS = 150
# Importing these does something (opens a browser, prints, runs a program), so they are never introspected.
NEVER_IMPORT = {'antigravity', 'this', '__hello__', '__phello__', 'idlelib.idle'}
# Class decorators that write __init__ from the annotated fields (dataclasses, attrs).
DATACLASS = {'dataclass', 'define', 'frozen', 'mutable', 's', 'attrs'}


def clip(s):
    if s is None:
        return None
    s = ' '.join(str(s).split())
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT - 1] + '…'


def first_line(doc):
    for line in (doc or '').strip().splitlines():
        if line.strip():
            return clip(line.strip())
    return ''


def param(name, kind, default=None, annotation=None):
    return {'name': name, 'kind': kind, 'default': clip(default), 'annotation': clip(annotation)}


# ---------- project files: ast only ----------

def source(src, node):
    if node is None:
        return None
    text = ast.get_source_segment(src, node)
    if text is None and hasattr(ast, 'unparse'):
        text = ast.unparse(node)
    return text


def ast_params(src, args, skip_first):
    out = []
    posonly = list(getattr(args, 'posonlyargs', []))
    positional = posonly + list(args.args)
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for i, a in enumerate(positional):
        out.append(param(a.arg, 'positional-only' if i < len(posonly) else 'positional', source(src, defaults[i]), source(src, a.annotation)))
    if args.vararg:
        out.append(param(args.vararg.arg, 'var-positional', None, source(src, args.vararg.annotation)))
    for a, d in zip(args.kwonlyargs, args.kw_defaults):
        out.append(param(a.arg, 'keyword-only', source(src, d), source(src, a.annotation)))
    if args.kwarg:
        out.append(param(args.kwarg.arg, 'var-keyword', None, source(src, args.kwarg.annotation)))
    if skip_first and out and out[0]['kind'] in ('positional', 'positional-only'):
        out = out[1:]
    return out


def decorator_names(src, node):
    names = []
    for d in node.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        names.append(source(src, target) or '')
    return names


def ast_function(src, node, skip_first=False):
    return {
        'name': node.name,
        'params': ast_params(src, node.args, skip_first),
        'returns': clip(source(src, node.returns)),
        'doc': first_line(ast.get_docstring(node)),
        'async': isinstance(node, ast.AsyncFunctionDef),
    }


def dataclass_fields(src, node, keyword_only):
    fields = []
    for item in node.body:
        if not isinstance(item, ast.AnnAssign) or not isinstance(item.target, ast.Name):
            continue
        ann = source(src, item.annotation) or ''
        if ann.startswith('ClassVar') or ann.startswith('typing.ClassVar') or ann.startswith('InitVar['):
            continue
        fields.append(param(item.target.id, 'keyword-only' if keyword_only else 'positional', source(src, item.value), ann))
    return fields


def ast_class(src, node, classes):
    decorators = decorator_names(src, node)
    methods = []
    init = None
    for item in node.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if item.name == '__init__':
            init = item
            continue
        if item.name.startswith('_'):
            continue
        decs = decorator_names(src, item)
        if any(d.endswith('property') or d.endswith('.setter') or d.endswith('.deleter') for d in decs):
            continue
        kind = 'static' if 'staticmethod' in decs else 'class' if 'classmethod' in decs else 'method'
        m = ast_function(src, item, skip_first=kind != 'static')
        m['kind'] = kind
        methods.append(m)
    if init is not None:
        params = ast_params(src, init.args, True)
    elif any(d.split('.')[-1] in DATACLASS for d in decorators):
        keyword_only = any(isinstance(d, ast.Call) and any(k.arg == 'kw_only' and isinstance(k.value, ast.Constant) and k.value.value is True for k in d.keywords) for d in node.decorator_list)
        params = dataclass_fields(src, node, keyword_only)
    else:
        params = None
        for base in node.bases:
            name = source(src, base)
            if name in classes:
                params = classes[name]['params']
                break
        if params is None:
            params = [] if not node.bases else [param('args', 'var-positional'), param('kwargs', 'var-keyword')]
    return {'name': node.name, 'params': params, 'doc': first_line(ast.get_docstring(node)), 'methods': methods}


def read_project_file(path, module):
    with open(path, 'rb') as f:
        data = f.read()
    src = data.decode('utf-8-sig', errors='replace')
    tree = ast.parse(src, filename=path)
    functions = []
    classes = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(ast_function(src, node))
        elif isinstance(node, ast.ClassDef):
            classes[node.name] = ast_class(src, node, classes)
    return {'name': module, 'doc': first_line(ast.get_docstring(tree)), 'functions': functions, 'classes': list(classes.values())}


def project():
    req = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    deadline = time.monotonic() + float(req.get('seconds') or 20)
    out = sys.stdout
    truncated = False
    for item in req.get('files') or []:
        if time.monotonic() > deadline:
            truncated = True
            break
        try:
            msg = {'path': item['path'], 'ok': True, 'module': read_project_file(item['path'], item['module'])}
        except (SyntaxError, ValueError, OSError, RecursionError, MemoryError) as e:
            msg = {'path': item['path'], 'ok': False, 'error': f'{type(e).__name__}: {e}'}
        out.write(json.dumps(msg, ensure_ascii=False) + '\n')
        out.flush()
    out.write(json.dumps({'done': True, 'truncated': truncated}) + '\n')


# ---------- installed packages: import and inspect ----------

def lib_roots():
    import sysconfig
    paths = sysconfig.get_paths()
    roots = [paths.get(k) for k in ('stdlib', 'platstdlib', 'purelib', 'platlib')]
    roots += [os.path.join(sys.base_prefix, 'DLLs'), os.path.join(sys.prefix, 'DLLs')]
    return [os.path.normcase(os.path.abspath(r)) for r in roots if r]


def under(path, folder):
    path = os.path.normcase(os.path.abspath(path))
    folder = os.path.normcase(os.path.abspath(folder)).rstrip('\\/')
    return path == folder or path.startswith(folder + os.sep)


def in_project(location, root, libs):
    """True when a module file or package folder is the project's own code (inside ROOT and not in an installed
    library folder, such as a .venv's site-packages inside the project)."""
    if not root or not location or location in ('built-in', 'frozen'):
        return False
    return under(location, root) and not any(under(location, lib) for lib in libs)


def check_location(spec, root, libs):
    locations = list(spec.submodule_search_locations or [])
    if spec.origin and spec.origin not in ('built-in', 'frozen'):
        locations.append(spec.origin)
    return next((loc for loc in locations if in_project(loc, root, libs)), None)


def sig_params(obj, skip_first=False):
    import inspect
    try:
        sig = inspect.signature(obj)
    except (TypeError, ValueError):
        return [param('args', 'var-positional'), param('kwargs', 'var-keyword')], None
    kinds = {
        inspect.Parameter.POSITIONAL_ONLY: 'positional-only', inspect.Parameter.POSITIONAL_OR_KEYWORD: 'positional',
        inspect.Parameter.VAR_POSITIONAL: 'var-positional', inspect.Parameter.KEYWORD_ONLY: 'keyword-only',
        inspect.Parameter.VAR_KEYWORD: 'var-keyword',
    }
    ann = lambda a: None if a is inspect.Parameter.empty else a if isinstance(a, str) else inspect.formatannotation(a)
    out = []
    for p in sig.parameters.values():
        default = None if p.default is inspect.Parameter.empty else repr(p.default)
        out.append(param(p.name, kinds[p.kind], default, ann(p.annotation)))
    if skip_first and out and out[0]['kind'] in ('positional', 'positional-only'):
        out = out[1:]
    return out, clip(ann(sig.return_annotation))


def describe_function(name, obj, skip_first=False):
    import inspect
    params, returns = sig_params(obj, skip_first)
    return {'name': name, 'params': params, 'returns': returns, 'doc': first_line(inspect.getdoc(obj)),
            'async': inspect.iscoroutinefunction(obj)}


def describe_class(name, cls):
    import inspect
    import types
    params, _ = sig_params(cls)
    methods = []
    base = set(dir(object))
    for m in dir(cls):
        if m.startswith('_') or m in base or len(methods) >= MAX_METHODS:
            continue
        try:
            raw = inspect.getattr_static(cls, m)
        except AttributeError:
            continue
        if isinstance(raw, staticmethod):
            kind, target, skip = 'static', getattr(cls, m), False
        elif isinstance(raw, (classmethod, types.ClassMethodDescriptorType)):
            kind, target, skip = 'class', getattr(cls, m), False
        elif inspect.isfunction(raw) or isinstance(raw, (types.MethodDescriptorType, types.WrapperDescriptorType)):
            kind, target, skip = 'method', raw, True
        else:
            continue
        d = describe_function(m, target, skip)
        d['kind'] = kind
        methods.append(d)
    return {'name': name, 'params': params, 'doc': first_line(inspect.getdoc(cls)), 'methods': methods}


def describe_module(mod, name):
    import inspect
    import pkgutil
    names = getattr(mod, '__all__', None)
    explicit = isinstance(names, (list, tuple)) and all(isinstance(n, str) for n in names)
    if not explicit:
        names = [n for n in dir(mod) if not n.startswith('_')]
    top = name.split('.')[0]
    functions, classes = [], []
    for n in list(names)[:MAX_MEMBERS]:
        if n.startswith('_'):
            continue
        try:
            obj = getattr(mod, n)
        except Exception:
            continue
        owner = getattr(obj, '__module__', None) or ''
        if not explicit and owner and owner.split('.')[0] != top and owner != name:
            continue
        if inspect.isclass(obj):
            classes.append(describe_class(n, obj))
        elif inspect.isroutine(obj):
            functions.append(describe_function(n, obj))
    out = {'name': name, 'doc': first_line(inspect.getdoc(mod)), 'functions': functions, 'classes': classes}
    if hasattr(mod, '__path__'):
        out['submodules'] = sorted(f'{name}.{m.name}' for m in pkgutil.iter_modules(mod.__path__) if not m.name.startswith('_'))
    return out


def module(name, root):
    import importlib
    import importlib.util
    parts = name.split('.')
    if not all(p.isidentifier() for p in parts) or name in NEVER_IMPORT or parts[-1] == '__main__':
        return {'ok': False, 'reason': 'refused', 'error': f'{name} cannot be loaded here.'}
    libs = lib_roots()
    for i in range(1, len(parts) + 1):
        sub = '.'.join(parts[:i])
        try:
            spec = importlib.util.find_spec(sub)
        except Exception as e:
            return {'ok': False, 'reason': 'import', 'error': f'{type(e).__name__}: {e}'}
        if spec is None:
            return {'ok': False, 'reason': 'missing', 'error': f'No module named {sub}'}
        if check_location(spec, root, libs):
            return {'ok': False, 'reason': 'project', 'error': f'{sub} is part of the project'}
    try:
        mod = importlib.import_module(name)
    except BaseException as e:
        return {'ok': False, 'reason': 'import', 'error': f'{type(e).__name__}: {e}'}
    return {'ok': True, 'module': describe_module(mod, name)}


def packages(root):
    import pkgutil
    libs = lib_roots()
    names = set(getattr(sys, 'stdlib_module_names', ()))
    names.update(sys.builtin_module_names)
    for m in pkgutil.iter_modules():
        path = getattr(m.module_finder, 'path', None)
        if path and in_project(path, root, libs):
            continue
        names.add(m.name)
    return {'ok': True, 'packages': sorted(n for n in names if n.isidentifier() and not n.startswith('_') and n not in NEVER_IMPORT)}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'project':
        project()
        return
    # Modules may print while they import; only the marked line is the answer.
    real = sys.stdout
    sys.stdout = sys.stderr
    try:
        if mode == 'module':
            result = module(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '')
        elif mode == 'packages':
            result = packages(sys.argv[2] if len(sys.argv) > 2 else '')
        else:
            result = {'ok': False, 'reason': 'usage', 'error': f'unknown mode {mode!r}'}
    except BaseException as e:
        result = {'ok': False, 'reason': 'error', 'error': f'{type(e).__name__}: {e}'}
    real.write('\n' + MARKER + json.dumps(result, ensure_ascii=False) + '\n')
    real.flush()


if __name__ == '__main__':
    main()
