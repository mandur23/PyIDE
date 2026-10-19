"""Static Django / Flask / FastAPI inspector for PyIDE's frameworks plugin.

Usage: python -I pyide_frameworks.py <project root>
Prints one JSON object. Nothing from the project is imported or executed; every fact comes from ast.
"""
import ast
import json
import os
import re
import sys

SKIP_DIRS = {
    '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.env', '.tox',
    '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages', 'dist', 'build', '.eggs',
}
MAX_FILES = 4000
MAX_BYTES = 1_000_000
TEMPLATE_EXTS = ('.html', '.htm', '.jinja', '.jinja2', '.j2', '.txt', '.xml')
FLASK_VERBS = {'route': None, 'get': 'GET', 'post': 'POST', 'put': 'PUT', 'delete': 'DELETE', 'patch': 'PATCH'}
FASTAPI_VERBS = {'get': 'GET', 'post': 'POST', 'put': 'PUT', 'delete': 'DELETE', 'patch': 'PATCH', 'options': 'OPTIONS',
                 'head': 'HEAD', 'trace': 'TRACE', 'api_route': None, 'websocket': 'WS'}
OWNER_KINDS = {'Flask': ('flask', 'app'), 'Blueprint': ('flask', 'blueprint'),
               'FastAPI': ('fastapi', 'app'), 'APIRouter': ('fastapi', 'router')}
FIELD_CALLS = {'ForeignKey', 'OneToOneField', 'ManyToManyField', 'GenericForeignKey', 'GenericRelation'}


def walk(root):
    files, templates = [], []
    for d, dirs, names in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith('.')
                         and not os.path.exists(os.path.join(d, x, 'pyvenv.cfg')))
        if os.path.basename(d) == 'templates':
            templates.append(d)
        for n in sorted(names):
            if n.endswith('.py') and len(files) < MAX_FILES:
                files.append(os.path.join(d, n))
    return files, templates


def const_str(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def call_name(node):
    """'models.CharField(...)' -> 'CharField'; 'Flask(...)' -> 'Flask'."""
    if not isinstance(node, ast.Call):
        return None
    f = node.func
    return f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None


def kwarg(call, name):
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def dotted(node):
    """Name/Attribute chain -> ['a', 'b', 'c'], or None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return parts[::-1]
    return None


def str_list(node):
    if isinstance(node, (ast.List, ast.Tuple)):
        return [s for s in (const_str(e) for e in node.elts) if s]
    return []


class Module:
    def __init__(self, name, path, tree, is_pkg):
        self.name, self.path, self.tree, self.is_pkg = name, path, tree, is_pkg
        self.package = name if is_pkg else name.rpartition('.')[0]
        self.imports = {}  # local name -> ('module', modname) | ('symbol', modname, attr)
        self.defs = {}  # top-level def/class name -> node
        self.star = []  # modules imported with *
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defs[node.name] = node
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.asname:
                        self.imports[a.asname] = ('module', a.name)
                    else:
                        top = a.name.split('.')[0]
                        self.imports.setdefault(top, ('module', top))
            elif isinstance(node, ast.ImportFrom):
                base = self.absolute(node.module, node.level)
                for a in node.names:
                    if a.name == '*':
                        self.star.append(base)
                    else:
                        self.imports[a.asname or a.name] = ('symbol', base, a.name)

    def absolute(self, module, level):
        if not level:
            return module or ''
        parts = self.package.split('.') if self.package else []
        if level > 1:
            parts = parts[:len(parts) - (level - 1)]
        return '.'.join([p for p in parts if p] + ([module] if module else []))


class Project:
    def __init__(self, root):
        self.root = root
        self.files, self.template_dirs = walk(root)
        self.modules = {}  # dotted name -> Module, for every source root
        self.by_path = {}
        self.roots = [root]

    def add_root(self, d):
        if d and os.path.isdir(d) and d not in self.roots:
            self.roots.insert(0, d)

    def index(self):
        for f in self.files:
            try:
                if os.path.getsize(f) > MAX_BYTES:
                    continue
                with open(f, 'rb') as fh:
                    tree = ast.parse(fh.read(), f)
            except (OSError, SyntaxError, ValueError):
                continue
            for r in self.roots:
                rel = os.path.relpath(f, r)
                if rel.startswith('..'):
                    continue
                parts = rel[:-3].replace('\\', '/').split('/')
                is_pkg = parts[-1] == '__init__'
                if is_pkg:
                    parts = parts[:-1]
                if not parts or not all(p.isidentifier() for p in parts):
                    continue
                name = '.'.join(parts)
                if name not in self.modules:
                    m = self.by_path.get(f) or Module(name, f, tree, is_pkg)
                    self.by_path[f] = m
                    self.modules[name] = m

    def module_of(self, path):
        return self.by_path.get(path)

    def resolve(self, mod, parts, depth=0):
        """Resolves a dotted reference seen in `mod` to (Module, [attrs]) where attrs name a symbol in that module."""
        if not parts or depth > 6:
            return None
        head, rest = parts[0], list(parts[1:])
        target = None
        if head in mod.imports:
            imp = mod.imports[head]
            if imp[0] == 'module':
                target = (imp[1], [])
            else:
                full = f'{imp[1]}.{imp[2]}' if imp[1] else imp[2]
                target = (full, []) if full in self.modules else (imp[1], [imp[2]])
        elif head in mod.defs or not rest:
            return mod, parts
        else:
            target = (mod.name, [head])
        modname, attrs = target
        attrs += rest
        while attrs and f'{modname}.{attrs[0]}' in self.modules:
            modname = f'{modname}.{attrs.pop(0)}'
        m = self.modules.get(modname)
        if not m:
            return None
        if attrs and attrs[0] not in m.defs and (attrs[0] in m.imports):
            return self.resolve(m, attrs, depth + 1)
        if attrs and attrs[0] not in m.defs:
            for star in m.star:
                sm = self.modules.get(star)
                if sm and attrs[0] in sm.defs:
                    return sm, attrs
        return m, attrs

    def locate(self, mod, parts):
        """(file, line) of the def a reference names, or of the module itself."""
        r = self.resolve(mod, parts)
        if not r:
            return None, None
        m, attrs = r
        node = m.defs.get(attrs[0]) if attrs else None
        if node is None:
            return (m.path, 1) if not attrs else (None, None)
        if len(attrs) > 1 and isinstance(node, ast.ClassDef):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name == attrs[1]:
                    return m.path, sub.lineno
        return m.path, node.lineno


def route(framework, methods, path, name, view, file, line, view_file, view_line):
    return {'framework': framework, 'methods': methods, 'path': path, 'name': name, 'view': view, 'file': file,
            'line': line, 'viewFile': view_file, 'viewLine': view_line}


def join_path(prefix, path):
    if not prefix:
        return path or '/'
    if not path:
        return prefix
    return prefix.rstrip('/') + '/' + path.lstrip('/')


# ---------- Django ----------

def find_manage(project):
    for f in project.files:
        if os.path.basename(f) != 'manage.py':
            continue
        if os.path.relpath(f, project.root).count(os.sep) > 2:
            continue
        try:
            with open(f, encoding='utf-8', errors='replace') as fh:
                text = fh.read()
        except OSError:
            continue
        m = re.search(r"DJANGO_SETTINGS_MODULE['\"]\s*,\s*['\"]([\w.]+)['\"]", text)
        if m:
            return f, m.group(1)
    return None, None


def settings_values(project, modname, seen=None):
    """Top-level assignments of a settings module, following `from x import *` like Django's split settings."""
    seen = seen or set()
    m = project.modules.get(modname)
    if not m or modname in seen:
        return {}, None
    seen.add(modname)
    values = {}
    for star in m.star:
        values.update(settings_values(project, star, seen)[0])
    for node in m.tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            values[node.targets[0].id] = (node.value, m)
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id in values:
            old, om = values[node.target.id]
            values[node.target.id] = (ast.List(elts=str_list_nodes(old) + str_list_nodes(node.value)), om)
    return values, m


def str_list_nodes(node):
    return list(node.elts) if isinstance(node, (ast.List, ast.Tuple)) else []


def model_classes(project, mod):
    out = []
    known = set()
    for node in mod.tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        bases = ['.'.join(dotted(b) or []) for b in node.bases]
        if not any(b.endswith('Model') or b.endswith('AbstractUser') or b.endswith('AbstractBaseUser') or b in known
                   for b in bases):
            continue
        known.add(node.name)
        fields = []
        for stmt in node.body:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                kind = call_name(stmt.value)
                if kind and (kind.endswith('Field') or kind in FIELD_CALLS):
                    fields.append({'name': stmt.targets[0].id, 'type': kind, 'line': stmt.lineno})
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                kind = call_name(stmt.value)
                if kind and (kind.endswith('Field') or kind in FIELD_CALLS):
                    fields.append({'name': stmt.target.id, 'type': kind, 'line': stmt.lineno})
        abstract = any(isinstance(s, ast.ClassDef) and s.name == 'Meta' and any(
            isinstance(a, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'abstract' for t in a.targets)
            for a in s.body) for s in node.body)
        out.append({'name': node.name, 'file': mod.path, 'line': node.lineno, 'fields': fields, 'abstract': abstract})
    return out


def admin_registrations(mod):
    out = []
    for node in ast.walk(mod.tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'register' \
                and (dotted(node.func.value) or [''])[-1] == 'site' and node.args:
            first = node.args[0]
            names = [dotted(e) for e in (first.elts if isinstance(first, (ast.List, ast.Tuple)) else [first])]
            admin = dotted(node.args[1]) if len(node.args) > 1 else None
            for n in names:
                if n:
                    out.append({'model': n[-1], 'admin': admin[-1] if admin else None, 'file': mod.path, 'line': node.lineno})
        elif isinstance(node, ast.ClassDef):
            for d in node.decorator_list:
                if isinstance(d, ast.Call) and (dotted(d.func) or [''])[-1] == 'register':
                    for a in d.args:
                        n = dotted(a)
                        if n:
                            out.append({'model': n[-1], 'admin': node.name, 'file': mod.path, 'line': node.lineno})
    return out


def app_module(project, entry):
    """'polls', 'polls.apps.PollsConfig' -> the local package Module, or None for django.contrib and third-party apps."""
    parts = entry.split('.')
    for n in range(len(parts), 0, -1):
        m = project.modules.get('.'.join(parts[:n]))
        if m and m.is_pkg:
            return m
    return None


def submodules(project, pkg, leaf):
    """pkg.leaf as a module, or every module of the pkg.leaf package."""
    name = f'{pkg.name}.{leaf}'
    return [m for k, m in project.modules.items() if k == name or k.startswith(name + '.')]


def django_urls(project, modname, prefix, namespace, out, urlconfs, depth=0):
    m = project.modules.get(modname)
    if not m or depth > 8:
        return
    urlconfs[modname] = m.path
    app_name = None
    elements = []
    for node in m.tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'app_name' for t in node.targets):
            app_name = const_str(node.value)
    for node in m.tree.body:
        value = None
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'urlpatterns' for t in node.targets):
            value = node.value
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == 'urlpatterns':
            value = node.value
        while isinstance(value, ast.BinOp):
            elements += str_list_nodes(value.right)
            value = value.left
        elements += str_list_nodes(value) if value is not None else []
    ns = namespace or app_name
    for call in elements:
        kind = call_name(call)
        if kind not in ('path', 're_path', 'url') or not call.args:
            continue
        pattern = const_str(call.args[0]) or ''
        if kind != 'path':
            pattern = pattern.lstrip('^').rstrip('$')
        view = call.args[1] if len(call.args) > 1 else kwarg(call, 'view')
        name = const_str(kwarg(call, 'name')) if kwarg(call, 'name') is not None else None
        if isinstance(view, ast.Call) and call_name(view) == 'include' and view.args:
            target = view.args[0]
            sub_ns = const_str(kwarg(view, 'namespace')) if kwarg(view, 'namespace') is not None else None
            if isinstance(target, ast.Tuple) and target.elts:
                sub_ns = sub_ns or (const_str(target.elts[1]) if len(target.elts) > 1 else None)
                target = target.elts[0]
            sub = const_str(target)
            if sub is None and dotted(target):
                r = project.resolve(m, dotted(target))
                sub = r[0].name if r and not r[1] else None
            if sub:
                django_urls(project, sub, prefix + pattern, sub_ns, out, urlconfs, depth + 1)
            continue
        parts = None
        if isinstance(view, ast.Call) and isinstance(view.func, ast.Attribute) and view.func.attr == 'as_view':
            parts = dotted(view.func.value)
        elif view is not None:
            parts = dotted(view)
        if not parts:
            continue
        text = '.'.join(parts)
        vf, vl = (None, None) if text.endswith('site.urls') else project.locate(m, parts)
        if vf and vl == 1 and project.module_of(vf) and project.module_of(vf).name.endswith(parts[-1]):
            vf, vl = None, None
        r = project.resolve(m, parts)
        full = '.'.join([r[0].name] + r[1]) if r else text
        out.append(route('django', [], '/' + prefix + pattern, f'{ns}:{name}' if ns and name else name, full,
                         m.path, call.lineno, vf, vl))


def inspect_django(project, manage, settings_name):
    base = os.path.dirname(manage)
    values, settings_mod = settings_values(project, settings_name)
    installed = []
    if 'INSTALLED_APPS' in values:
        installed = str_list(values['INSTALLED_APPS'][0])
    root_urlconf = const_str(values['ROOT_URLCONF'][0]) if 'ROOT_URLCONF' in values else None
    apps = []
    for entry in installed:
        pkg = app_module(project, entry)
        if not pkg or any(a['name'] == pkg.name for a in apps):
            continue
        models = [c for mm in submodules(project, pkg, 'models') for c in model_classes(project, mm)]
        admin = [r for mm in submodules(project, pkg, 'admin') for r in admin_registrations(mm)]
        apps.append({'name': pkg.name, 'entry': entry, 'path': os.path.dirname(pkg.path), 'file': pkg.path,
                     'models': models, 'admin': admin})
    urls, urlconfs = [], {}
    if root_urlconf:
        django_urls(project, root_urlconf, '', None, urls, urlconfs)
    return {
        'manage': manage, 'baseDir': base, 'settingsModule': settings_name,
        'settingsFile': settings_mod.path if settings_mod else None, 'rootUrlconf': root_urlconf,
        'installedApps': installed, 'apps': apps, 'urlconfs': urlconfs,
    }, urls


def template_libraries(project):
    libs = {}
    for f in project.files:
        if os.path.basename(os.path.dirname(f)) != 'templatetags' or f.endswith('__init__.py'):
            continue
        m = project.module_of(f)
        if not m:
            continue
        lib = {'tags': [], 'filters': []}
        for node in ast.walk(m.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for d in node.decorator_list:
                    fn = d.func if isinstance(d, ast.Call) else d
                    parts = dotted(fn) or []
                    if len(parts) == 2 and parts[0] == 'register':
                        explicit = None
                        if isinstance(d, ast.Call):
                            explicit = const_str(kwarg(d, 'name')) or (const_str(d.args[0]) if d.args else None)
                        key = 'filters' if parts[1] == 'filter' else 'tags'
                        if parts[1] in ('filter', 'simple_tag', 'inclusion_tag', 'tag'):
                            lib[key].append(explicit if explicit and parts[1] != 'inclusion_tag' else node.name)
        libs[os.path.basename(f)[:-3]] = lib
    return libs


# ---------- Flask and FastAPI ----------

def inspect_web(project):
    owners = {}  # (module, var) -> {kind, framework, name, prefix, file, line, factory}
    apps = {'flask': [], 'fastapi': []}
    decorated = []
    mounts = []  # (owner key of parent, child ref (Module, parts), prefix, framework)

    def scope_walk(mod, body, factory):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decorated.append((mod, node, factory))
                scope_walk(mod, node.body, factory or node.name)
            elif isinstance(node, ast.ClassDef):
                continue
            else:
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Assign) and len(sub.targets) == 1 and isinstance(sub.targets[0], ast.Name):
                        kind = call_name(sub.value)
                        if kind in OWNER_KINDS:
                            fw, role = OWNER_KINDS[kind]
                            var = sub.targets[0].id
                            info = {'framework': fw, 'role': role, 'var': var, 'module': mod.name, 'file': mod.path,
                                    'line': sub.lineno, 'factory': factory, 'prefix': '', 'name': None}
                            if kind == 'Blueprint':
                                info['name'] = const_str(sub.value.args[0]) if sub.value.args else var
                                p = kwarg(sub.value, 'url_prefix')
                                info['prefix'] = const_str(p) or '' if p is not None else ''
                            if kind == 'APIRouter':
                                p = kwarg(sub.value, 'prefix')
                                info['prefix'] = const_str(p) or '' if p is not None else ''
                            owners[(mod.name, var)] = info
                            if role == 'app':
                                apps[fw].append(info)
                    if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) \
                            and sub.func.attr in ('register_blueprint', 'include_router') and sub.args:
                        parent = dotted(sub.func.value)
                        child = dotted(sub.args[0])
                        kw = 'url_prefix' if sub.func.attr == 'register_blueprint' else 'prefix'
                        p = kwarg(sub, kw)
                        if parent and child:
                            mounts.append((mod, parent, child, const_str(p) if p is not None else None, sub.func.attr))

    for mod in list(project.by_path.values()):
        scope_walk(mod, mod.tree.body, None)

    def owner_for(mod, parts):
        if len(parts) == 1 and (mod.name, parts[0]) in owners:
            return owners[(mod.name, parts[0])]
        r = project.resolve(mod, parts)
        if r and len(r[1]) == 1:
            return owners.get((r[0].name, r[1][0]))
        return None

    mounted = {}  # id(owner) -> (parent owner, prefix override or None, kind)
    for mod, parent, child, prefix, how in mounts:
        po, co = owner_for(mod, parent), owner_for(mod, child)
        if po and co:
            mounted[id(co)] = (po, prefix, how)

    def full_prefix(o, depth=0):
        if depth > 8:
            return ''
        m = mounted.get(id(o))
        own = o['prefix']
        if not m:
            return own
        parent, prefix, how = m
        if how == 'register_blueprint':
            own = prefix if prefix is not None else own
        else:
            own = join_path(prefix or '', own) if prefix else own
        return join_path(full_prefix(parent, depth + 1), own) if full_prefix(parent, depth + 1) else own

    routes = []
    for mod, fn, _factory in decorated:
        for d in fn.decorator_list:
            if not (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)):
                continue
            parts = dotted(d.func.value)
            if not parts:
                continue
            o = owner_for(mod, parts)
            if not o:
                continue
            verbs = FLASK_VERBS if o['framework'] == 'flask' else FASTAPI_VERBS
            if d.func.attr not in verbs:
                continue
            path = (const_str(d.args[0]) if d.args else None)
            if path is None:
                path = const_str(kwarg(d, 'path') or kwarg(d, 'rule') or ast.Constant(value=''))
            method = verbs[d.func.attr]
            methods = [method] if method else (str_list(kwarg(d, 'methods')) if kwarg(d, 'methods') is not None else ['GET'])
            endpoint = fn.name
            if o['framework'] == 'flask':
                ep = kwarg(d, 'endpoint')
                endpoint = const_str(ep) if ep is not None and const_str(ep) else fn.name
                if o['role'] == 'blueprint':
                    endpoint = f"{o['name']}.{endpoint}"
            routes.append(route(o['framework'], [m.upper() for m in methods], join_path(full_prefix(o), path),
                                endpoint, f'{mod.name}.{fn.name}', mod.path, d.lineno, mod.path, fn.lineno))
    out = {}
    for fw in ('flask', 'fastapi'):
        if apps[fw]:
            out[fw] = {'apps': [{k: a[k] for k in ('var', 'module', 'file', 'line', 'factory')} for a in apps[fw]]}
    return out, routes


def template_refs_dirs(project):
    """Extra template folders named in code: Flask(template_folder=...), Jinja2Templates(directory=...)."""
    out = []
    for mod in project.by_path.values():
        for node in ast.walk(mod.tree):
            name = call_name(node)
            arg = kwarg(node, 'template_folder') if name in ('Flask', 'Blueprint') else \
                kwarg(node, 'directory') if name == 'Jinja2Templates' else None
            s = const_str(arg) if arg is not None else None
            if s:
                for base in (os.path.dirname(mod.path), project.root):
                    d = os.path.normpath(os.path.join(base, s))
                    if os.path.isdir(d):
                        out.append(d)
                        break
    return out


def template_files(dirs):
    """Template names as templates refer to them ('polls/index.html'); the first folder that has a name wins."""
    out, seen = [], set()
    for base in dirs:
        for d, subdirs, names in os.walk(base):
            subdirs[:] = sorted(x for x in subdirs if x not in SKIP_DIRS)
            for n in sorted(names):
                if n.lower().endswith(TEMPLATE_EXTS):
                    p = os.path.join(d, n)
                    name = os.path.relpath(p, base).replace(os.sep, '/')
                    if name not in seen and len(out) < MAX_FILES:
                        seen.add(name)
                        out.append({'name': name, 'path': p})
    return out


def main():
    root = os.path.abspath(sys.argv[1])
    project = Project(root)
    manage, settings_name = find_manage(project)
    if manage:
        project.add_root(os.path.dirname(manage))
    project.index()
    result = {'root': root, 'django': None, 'flask': None, 'fastapi': None, 'routes': [], 'templateLibs': {}}
    if manage:
        result['django'], urls = inspect_django(project, manage, settings_name)
        result['routes'] += urls
        result['templateLibs'] = template_libraries(project)
    web, routes = inspect_web(project)
    result.update(web)
    result['routes'] += routes
    dirs = []
    for d in project.template_dirs + template_refs_dirs(project):
        if d not in dirs:
            dirs.append(d)
    # Project-level folders first (Django's DIRS), then app folders.
    dirs.sort(key=lambda d: os.path.relpath(d, root).count(os.sep))
    result['templateDirs'] = dirs
    result['templates'] = template_files(dirs)
    sys.stdout.write(json.dumps(result))


if __name__ == '__main__':
    main()
