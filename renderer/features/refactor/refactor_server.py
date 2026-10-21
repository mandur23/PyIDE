"""PyIDE refactoring sidecar: JSON lines over stdin/stdout, run by main/features/refactor.js in the project interpreter.

Rope (https://github.com/python-rope/rope) does the analysis-heavy refactorings: Extract Variable/Method, Inline,
Change Signature and Move. Extract Constant and Extract Parameter are implemented here on the stdlib `ast`, because
rope places constants after the current function and only introduces parameters for plain names. Rope's results are
post-processed to read like PyCharm's: `from module import name` imports, moved code appended to the destination,
and PEP 8 blank lines around new and removed definitions.

Nothing is written to disk. Every request names the project root and an overlay of unsaved editor buffers; rope reads
files through an overlay file system, intermediate steps of multi-step refactorings stay in memory, and the reply lists
each changed file's old and new text plus file moves. The IDE previews and applies them.

Requests: {"id", "method", "params"}. Replies: {"id", "result"} or {"id", "error": {"code", "message", "params"}}.
"""
import ast
import difflib
import importlib
import json
import keyword
import os
import re
import sys
import traceback

rope = None


def load_rope():
    global rope
    if rope is None:
        importlib.invalidate_caches()
        try:
            import rope as _rope
            import rope.base.change  # noqa: F401
            import rope.base.fscommands  # noqa: F401
            import rope.base.libutils  # noqa: F401
            import rope.base.project  # noqa: F401
            import rope.refactor.change_signature  # noqa: F401
            import rope.refactor.extract  # noqa: F401
            import rope.refactor.importutils  # noqa: F401
            import rope.refactor.inline  # noqa: F401
            import rope.refactor.move  # noqa: F401
            import rope.refactor.rename  # noqa: F401
        except ImportError:
            return None
        rope = _rope
        patch_add_import()
    return rope.VERSION


class Fail(Exception):
    """A refactoring that cannot be performed; `code` selects the IDE's (translated) message."""

    def __init__(self, code, message, **params):
        super().__init__(message)
        self.code = code
        self.message = message
        self.params = params


# Rope's own messages for common situations, mapped to IDE messages.
ROPE_ERRORS = [
    (r'Bad region selected|should contain complete statements|Extracted piece|not a valid expression|'
     r'Cannot extract|should be an expression', 'not-extractable'),
    (r'Not a resolvable python identifier|should be performed on', 'no-target'),
    (r'assigned once', 'assigned-more-than-once'),
    (r'syntax', 'syntax-error'),
]


def rope_fail(err):
    message = str(err) or type(err).__name__
    for pattern, code in ROPE_ERRORS:
        if re.search(pattern, message, re.I):
            return Fail(code, message, detail=message)
    return Fail('rope', message, detail=message)


# ---------- text positions ----------
def key(path):
    return os.path.normcase(os.path.abspath(path))


def line_starts(text):
    starts = [0]
    for i, ch in enumerate(text):
        if ch == '\n':
            starts.append(i + 1)
    return starts


def u16_to_index(line, col16):
    if line.isascii():
        return min(col16, len(line))
    n = 0
    for i, ch in enumerate(line):
        if n >= col16:
            return i
        n += 2 if ord(ch) > 0xFFFF else 1
    return len(line)


def index_to_u16(line, idx):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in line[:idx])


def offset_of(text, line, col):
    """1-based line and UTF-16 column (Monaco) -> character offset."""
    lines = text.split('\n')
    line = max(1, min(line, len(lines)))
    return sum(len(x) + 1 for x in lines[:line - 1]) + u16_to_index(lines[line - 1], col - 1)


def position_of(text, offset):
    """Character offset -> {line, col} (1-based, UTF-16 column)."""
    starts = line_starts(text)
    lo = 0
    for i, s in enumerate(starts):
        if s > offset:
            break
        lo = i
    line_text = text[starts[lo]:].split('\n', 1)[0]
    return {'line': lo + 1, 'col': index_to_u16(line_text, offset - starts[lo]) + 1}


class Source:
    """A parsed module with conversions between ast positions (UTF-8 byte columns) and character offsets."""

    def __init__(self, text):
        self.text = text
        self.lines = text.split('\n')
        self.starts = line_starts(text)
        try:
            self.tree = ast.parse(text)
        except SyntaxError as e:
            raise Fail('syntax-error', f'The file has syntax errors (line {e.lineno})', line=e.lineno or 0)
        self.parents = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parents[child] = node

    def off(self, lineno, col_offset):
        line = self.lines[lineno - 1]
        return self.starts[lineno - 1] + len(line.encode('utf-8')[:col_offset].decode('utf-8', 'ignore'))

    def span(self, node):
        return self.off(node.lineno, node.col_offset), self.off(node.end_lineno, node.end_col_offset)

    def segment(self, node):
        s, e = self.span(node)
        return self.text[s:e]

    def ancestors(self, node):
        while node in self.parents:
            node = self.parents[node]
            yield node

    def enclosing_function(self, node):
        for a in self.ancestors(node):
            if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                return a
            if isinstance(a, ast.ClassDef):
                return None
        return None


def strip_span(text, s, e):
    while s < e and text[s].isspace():
        s += 1
    while e > s and text[e - 1].isspace():
        e -= 1
    return s, e


EXPR_EXCLUDED = (ast.Starred, ast.Slice, ast.FormattedValue)


def extractable(src, node):
    if not isinstance(node, ast.expr) or isinstance(node, EXPR_EXCLUDED):
        return False
    if isinstance(getattr(node, 'ctx', None), (ast.Store, ast.Del)):
        return False
    parent = src.parents.get(node)
    if isinstance(parent, ast.keyword) or isinstance(parent, (ast.arg, ast.arguments)):
        return isinstance(parent, ast.keyword) and parent.value is node
    # Before 3.12, positions inside f-strings are unreliable.
    if sys.version_info < (3, 12) and any(isinstance(a, ast.JoinedStr) for a in src.ancestors(node)):
        return False
    if any(isinstance(a, (ast.Global, ast.Nonlocal)) for a in src.ancestors(node)):
        return False
    return True


def find_expression(src, s, e):
    s, e = strip_span(src.text, s, e)
    found = None
    for node in ast.walk(src.tree):
        if isinstance(node, ast.expr) and src.span(node) == (s, e) and extractable(src, node):
            if found is None or found in src.ancestors(node):
                found = node
    if found is None:
        # A selection of a parenthesized expression includes the parentheses.
        if s < e and src.text[s] == '(' and src.text[e - 1] == ')':
            return find_expression(src, s + 1, e - 1)
        raise Fail('not-expression', 'Cannot perform refactoring using selected element(s)')
    return found


def expression_choices(src, offset):
    """Expressions around the caret, innermost first (PyCharm's expression chooser)."""
    out = []
    for node in ast.walk(src.tree):
        if not isinstance(node, ast.expr) or not extractable(src, node):
            continue
        s, e = src.span(node)
        if s <= offset <= e and '\n' not in src.text[s:e]:
            out.append((e - s, s, e, node))
    out.sort(key=lambda t: (t[0], t[1]))
    seen = set()
    choices = []
    for _, s, e, node in out:
        if (s, e) in seen or isinstance(node, ast.Name) and isinstance(src.parents.get(node), ast.Call) and src.parents[node].func is node:
            continue
        seen.add((s, e))
        choices.append({'start': position_of(src.text, s), 'end': position_of(src.text, e), 'text': src.text[s:e]})
    return choices[:8]


# ---------- names ----------
def is_identifier(name):
    return bool(name) and name.isidentifier() and not keyword.iskeyword(name)


def check_identifier(name):
    if not is_identifier(name):
        raise Fail('invalid-name', f"'{name}' is not a valid identifier", name=name)


def snake(name):
    name = re.sub(r'(?<=[a-z0-9])([A-Z])', r'_\1', name).lower()
    return name.strip('_') or 'value'


# Names for the results of builtins, which would otherwise shadow the builtin.
BUILTIN_NAMES = {
    'len': 'length', 'str': 'text', 'repr': 'text', 'format': 'text', 'input': 'text', 'int': 'number',
    'float': 'number', 'round': 'rounded', 'abs': 'absolute', 'sum': 'total', 'max': 'maximum', 'min': 'minimum',
    'list': 'items', 'tuple': 'items', 'set': 'items', 'sorted': 'items', 'reversed': 'items', 'dict': 'mapping',
    'range': 'numbers', 'open': 'file', 'enumerate': 'pairs', 'zip': 'pairs', 'bool': 'flag', 'type': 'kind',
}


def suggest_name(node):
    if isinstance(node, ast.Call):
        f = node.func
        name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
        if name in BUILTIN_NAMES:
            return BUILTIN_NAMES[name]
        if name:
            name = re.sub(r'^(get|create|make|build|compute|calculate|calc|find|load|read|fetch)_?(?=[A-Za-z])', '', name)
            return snake(name)
    if isinstance(node, ast.Attribute):
        return snake(node.attr)
    if isinstance(node, ast.Name):
        return snake(node.id)
    if isinstance(node, ast.Subscript):
        return 'item'
    if isinstance(node, (ast.JoinedStr,)) or isinstance(node, ast.Constant) and isinstance(node.value, str):
        return 'text'
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, complex)) and not isinstance(node.value, bool):
        return 'number'
    if isinstance(node, (ast.Compare, ast.BoolOp)) or isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return 'condition'
    if isinstance(node, (ast.List, ast.ListComp, ast.Set, ast.SetComp, ast.Tuple, ast.GeneratorExp)):
        return 'items'
    if isinstance(node, (ast.Dict, ast.DictComp)):
        return 'mapping'
    if isinstance(node, ast.Lambda):
        return 'function'
    if isinstance(node, ast.BinOp):
        return {ast.Add: 'total', ast.Sub: 'difference', ast.Mult: 'product', ast.Div: 'ratio', ast.Mod: 'remainder'}.get(type(node.op), 'result')
    return 'value'


def all_names(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.alias):
            names.add((node.asname or node.name).split('.')[0])
    return names


def unique(base, taken, upper=False):
    base = base.upper() if upper else base
    if not is_identifier(base):
        base = 'VALUE' if upper else 'value'
    name, i = base, 1
    while name in taken or keyword.iskeyword(name) or name in dir(__builtins__):
        name = f'{base}{i}'
        i += 1
    return name


def local_names(func):
    """Names bound inside a function (parameters, assignments, loops, imports, nested defs), not in nested scopes."""
    names = set()
    a = func.args
    for arg in [*getattr(a, 'posonlyargs', []), *a.args, *a.kwonlyargs, a.vararg, a.kwarg]:
        if arg:
            names.add(arg.arg)
    if isinstance(func, ast.Lambda):
        return names
    stack = list(func.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            continue
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
        elif isinstance(node, ast.alias):
            names.add((node.asname or node.name).split('.')[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.Global):
            continue
        stack.extend(ast.iter_child_nodes(node))
    for node in ast.walk(func):
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            names -= set(node.names)
    return names


def free_names(node):
    """Names an expression reads, minus those its own comprehensions and lambdas bind."""
    bound = set()
    for n in ast.walk(node):
        if isinstance(n, ast.comprehension):
            for t in ast.walk(n.target):
                if isinstance(t, ast.Name):
                    bound.add(t.id)
        elif isinstance(n, ast.Lambda):
            bound |= local_names(n)
        elif isinstance(n, ast.NamedExpr):
            bound.add(n.target.id)
    return [n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in bound]


def same_expression(a, b):
    return ast.dump(a) == ast.dump(b)


# ---------- blank lines ----------
def indent_of(line):
    return len(line) - len(line.lstrip())


def tidy(old, new):
    """Collapses runs of blank lines that a change created beyond PEP 8 (2 at top level, 1 inside blocks)."""
    if old is None or old == new:
        return new
    a, b = old.split('\n'), new.split('\n')
    touched = [False] * (len(b) + 1)
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag != 'equal':
            for j in range(max(0, j1 - 1), min(len(b), j2 + 1)):
                touched[j] = True
    out = []
    j = 0
    while j < len(b):
        if b[j].strip():
            out.append(b[j])
            j += 1
            continue
        k = j
        while k < len(b) and not b[k].strip():
            k += 1
        run = k - j
        if any(touched[j:k + 1]) or (j and touched[j - 1]):
            nxt = b[k] if k < len(b) else None
            if j == 0 and not (old[:1] == '\n'):
                run = 0
            elif nxt is None:
                run = min(run, 1)
            else:
                run = min(run, 2 if indent_of(nxt) == 0 else 1)
        out.extend([''] * run)
        j = k
    text = '\n'.join(out)
    if old.endswith('\n') and text and not text.endswith('\n'):
        text += '\n'
    return text


def import_names(stmt):
    return [(a.asname or a.name).split('.')[0] for a in stmt.names if a.name != '*']


def keep_imports(old, new):
    """Rope's import cleanup can drop imports the module still uses (a star import, or one rope thinks unused).
    Restores a removed top-level import when it is a star import or binds a name the new text still reads."""
    try:
        before, after = ast.parse(old), ast.parse(new)
    except SyntaxError:
        return new
    kept = [st for st in after.body if isinstance(st, (ast.Import, ast.ImportFrom))]
    kept_text = {ast.unparse(st) for st in kept}
    bound = {n for st in kept for n in import_names(st)}
    used = {n.id for n in ast.walk(after) if isinstance(n, ast.Name)}
    old_lines = old.split('\n')
    restore = []
    for st in before.body:
        if not isinstance(st, (ast.Import, ast.ImportFrom)) or ast.unparse(st) in kept_text:
            continue
        star = any(a.name == '*' for a in st.names)
        if star or any(n in used and n not in bound for n in import_names(st)):
            restore.append('\n'.join(old_lines[st.lineno - 1:st.end_lineno]))
    if not restore:
        return new
    lines = new.split('\n')
    at = max((st.end_lineno for st in kept), default=import_block_end(after))
    lines[at:at] = restore
    return '\n'.join(lines)


def node_lines(node):
    first = min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])])
    return first, node.end_lineno


def set_blank_lines(lines, at, count):
    """Makes exactly `count` blank lines directly above index `at` (0-based). Returns the shift of `at`."""
    i = at
    while i > 0 and not lines[i - 1].strip():
        i -= 1
    if i == 0:
        return 0
    old = at - i
    lines[i:at] = [''] * count
    return count - old


def space_definition(text, name, node_type=(ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
    """Gives a definition PEP 8 spacing: 2 blank lines around top-level ones, 1 around methods."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return text
    target = None
    container = None
    for node in tree.body:
        if isinstance(node, node_type) and node.name == name:
            target = node
        elif isinstance(node, ast.ClassDef):
            for m in node.body:
                if isinstance(m, node_type) and m.name == name:
                    target, container = m, node
    if target is None:
        return text
    lines = text.split('\n')
    want = 1 if container else 2
    first, last = node_lines(target)
    # Blank lines after: count from the end of the definition to the next code line.
    k = last
    while k < len(lines) and not lines[k].strip():
        k += 1
    if k < len(lines) and lines[k].strip():
        after = 2 if indent_of(lines[k]) == 0 else want
        lines[last:k] = [''] * after
    above = first - 1
    if above > 0:
        j = above
        while j > 0 and not lines[j - 1].strip():
            j -= 1
        prev = lines[j - 1] if j > 0 else ''
        if j > 0 and not prev.rstrip().endswith(':'):
            set_blank_lines(lines, above, want)
    return '\n'.join(lines)


# ---------- workspace: overlay of unsaved buffers + in-memory results ----------
class Workspace:
    def __init__(self, root, overlay=None):
        self.root = os.path.abspath(root)
        self.texts = {}
        self.original = {}
        self.real = {}
        self.moves = []
        self.created = set()
        self.sources = None
        for path, text in (overlay or {}).items():
            k = key(path)
            self.texts[k] = self.original[k] = text.replace('\r\n', '\n')
            self.real[k] = os.path.abspath(path)

    def read(self, path):
        k = key(path)
        if k not in self.texts:
            try:
                with open(path, 'rb') as f:
                    data = f.read()
            except FileNotFoundError:
                data = b''
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                raise Fail('encoding', f'{os.path.basename(path)} is not UTF-8', file=path)
            self.texts[k] = self.original[k] = text.replace('\r\n', '\n').replace('\r', '\n')
            self.real[k] = os.path.abspath(path)
        return self.texts[k]

    def write(self, path, text):
        self.read(path)
        self.texts[key(path)] = text

    def check_inside(self, path):
        rel = os.path.relpath(os.path.abspath(path), self.root)
        if rel.startswith('..') or os.path.isabs(rel):
            raise Fail('outside-project', 'The file is not inside the project')

    def project(self):
        fs = OverlayFS(self)
        project = rope.base.project.Project(self.root, ropefolder=None, fscommands=fs)
        prefs = project.prefs
        for pattern in ['node_modules', '__pycache__', '.idea', '.ruff_cache', 'build', 'dist', 'site-packages', '.eggs', 'env']:
            if pattern not in prefs.ignored_resources:
                prefs.ignored_resources.append(pattern)
        prefs.imports.preferred_import_style = 'from-global'
        return project

    def resource(self, project, path):
        return rope.base.libutils.path_to_resource(project, os.path.abspath(path))

    def absorb(self, changes, tidy_files=True):
        for ch in flatten(changes):
            if isinstance(ch, rope.base.change.ChangeContents):
                path = ch.resource.real_path
                old = self.read(path)
                self.write(path, tidy(old, keep_imports(old, ch.new_contents)) if tidy_files else ch.new_contents)
            elif isinstance(ch, rope.base.change.MoveResource):
                self.moves.append((ch.resource.real_path, ch.new_resource.real_path))
            elif isinstance(ch, rope.base.change.CreateResource):
                self.created.add(key(ch.resource.real_path))
            else:
                raise Fail('rope', f'Unsupported change: {type(ch).__name__}', detail=type(ch).__name__)

    def result(self, description, **extra):
        changes = []
        for k, text in self.texts.items():
            old = self.original.get(k)
            if text != old or k in self.created:
                changes.append({'path': self.real[k], 'old': old if k not in self.created else None, 'new': text})
        if not changes and not self.moves:
            raise Fail('nothing', 'Nothing to change')
        changes.sort(key=lambda c: c['path'].lower())
        return {'description': description, 'changes': changes,
                'moves': [{'from': a, 'to': b} for a, b in self.moves], **extra}


def flatten(changes):
    if isinstance(changes, rope.base.change.ChangeSet):
        for c in changes.changes:
            yield from flatten(c)
    else:
        yield changes


def make_overlay_fs():
    base = rope.base.fscommands.FileSystemCommands

    class _OverlayFS(base):
        def __init__(self, ws):
            self.ws = ws

        def read(self, path):
            return self.ws.read(path).encode('utf-8')

        def _refuse(self, *args, **kwargs):
            raise RuntimeError('the refactoring sidecar never writes files')

        create_file = create_folder = move = remove = write = _refuse

    return _OverlayFS


_overlay_cls = None


def OverlayFS(ws):
    global _overlay_cls
    if _overlay_cls is None:
        _overlay_cls = make_overlay_fs()
    return _overlay_cls(ws)


def patch_add_import():
    """Move rewrites imports as `from module import name`, merged into an existing `from module import …` (PyCharm's
    style). Rope's own add_import prefers extending any import of the parent package, giving `pkg.mod.name` usages."""
    from rope.refactor import importutils
    from rope.refactor.importutils import actions, importinfo

    def add_import(project, pymodule, module_name, name=None):
        imports = importutils.get_module_imports(project, pymodule)
        if name is None:
            candidate, imported = importinfo.NormalImport([(module_name, None)]), module_name
        else:
            candidate, imported = importinfo.FromImport(module_name, 0, [(name, None)]), name
        visitor = actions.AddingVisitor(project, [candidate])
        selected = candidate
        for statement in imports.imports:
            if statement.accept(visitor):
                selected = visitor.import_info
                break
        imports.add_import(selected)
        return imports.get_changed_source(), imported

    importutils.add_import = add_import


# ---------- shared helpers for requests ----------
def require_rope():
    if load_rope() is None:
        raise Fail('no-rope', 'Refactoring needs the rope library in the project interpreter')


def open_file(params):
    ws = Workspace(params['root'], params.get('overlay'))
    path = os.path.abspath(params['file'])
    ws.check_inside(path)
    text = ws.read(path)
    return ws, path, text


def selection(params, text):
    r = params['range']
    s = offset_of(text, r['startLine'], r['startCol'])
    e = offset_of(text, r['endLine'], r['endCol'])
    return min(s, e), max(s, e)


def caret_at(text, path, needle_re, after=0):
    m = re.compile(needle_re, re.M).search(text, after)
    if not m:
        return None
    pos = position_of(text, m.start(1) if m.groups() else m.start())
    return {'path': path, **pos}


def occurrences_in(src, scope, node):
    return [n for n in ast.walk(scope) if isinstance(n, ast.expr) and same_expression(n, node) and extractable(src, n)]


def replace_spans(text, spans, replacement):
    for s, e in sorted(spans, reverse=True):
        text = text[:s] + replacement + text[e:]
    return text


# ---------- Extract Variable / Constant / Parameter: preparing ----------
def prepare_expression(params):
    """Validates the selection (or offers choices around the caret) and suggests a name."""
    if params.get('op') == 'variable':
        require_rope()
    ws, path, text = open_file(params)
    src = Source(text)
    s, e = selection(params, text)
    if s == e:
        choices = expression_choices(src, s)
        if not choices:
            raise Fail('not-expression', 'Cannot perform refactoring using selected element(s)')
        if len(choices) > 1:
            return {'choices': choices}
        c = choices[0]
        s = offset_of(text, c['start']['line'], c['start']['col'])
        e = offset_of(text, c['end']['line'], c['end']['col'])
    node = find_expression(src, s, e)
    op = params['op']
    taken = all_names(src.tree)
    if op == 'constant':
        check_constant(src, node)
        scope = src.tree
    elif op == 'parameter':
        func = parameter_function(src, node)
        scope = func
    else:
        scope = src.enclosing_function(node) or src.tree
    s, e = src.span(node)
    count = len(occurrences_in(src, scope, node))
    return {
        'range': {'start': position_of(text, s), 'end': position_of(text, e)},
        'expression': src.text[s:e],
        'name': unique(suggest_name(node), taken, upper=op == 'constant'),
        'occurrences': count,
    }


def resolve_expression(params, text, src):
    s, e = selection(params, text)
    return find_expression(src, s, e)


def check_constant(src, node):
    for a in src.ancestors(node):
        if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            local = local_names(a)
            for name in free_names(node):
                if name in local:
                    raise Fail('uses-local', f"The expression uses local variable '{name}'", name=name)
        elif isinstance(a, ast.ClassDef):
            bound = {t.id for st in a.body for t in ast.walk(st) if isinstance(t, ast.Name) and isinstance(t.ctx, ast.Store)}
            bound |= {st.name for st in a.body if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
            for name in free_names(node):
                if name in bound:
                    raise Fail('uses-local', f"The expression uses local variable '{name}'", name=name)


def parameter_function(src, node):
    func = None
    for a in src.ancestors(node):
        if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func = a
            break
        if isinstance(a, (ast.Lambda, ast.ClassDef)):
            break
    if func is None or not inside_body(func, node):
        raise Fail('not-in-function', 'The selected expression is not inside a function body')
    local = local_names(func)
    for name in free_names(node):
        if name in local:
            raise Fail('uses-local', f"The expression uses local variable '{name}'", name=name)
    return func


# ---------- Extract Variable (rope) ----------
def extract_variable(params):
    require_rope()
    ws, path, text = open_file(params)
    src = Source(text)
    node = resolve_expression(params, text, src)
    name = params['name']
    check_identifier(name)
    s, e = src.span(node)
    project = ws.project()
    try:
        changes = rope.refactor.extract.ExtractVariable(project, ws.resource(project, path), s, e).get_changes(
            name, similar=bool(params.get('similar')))
        ws.absorb(changes)
    except Fail:
        raise
    except Exception as err:
        raise rope_fail(err)
    finally:
        project.close()
    new = ws.texts[key(path)]
    line_start = text.rfind('\n', 0, s) + 1
    return ws.result(f'Extract variable {name}', caret=caret_at(new, path, rf'^[ \t]*({re.escape(name)})\s*=', max(0, line_start - 200)))


# ---------- Extract Constant (ast) ----------
def import_block_end(tree):
    """Index (0-based line) after the module docstring and the leading imports."""
    end = 0
    for i, st in enumerate(tree.body):
        if i == 0 and isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str):
            end = st.end_lineno
        elif isinstance(st, (ast.Import, ast.ImportFrom)):
            end = st.end_lineno
        elif isinstance(st, ast.If) and all(isinstance(x, (ast.Import, ast.ImportFrom)) for x in st.body):
            end = st.end_lineno  # if TYPE_CHECKING: imports
        elif isinstance(st, ast.Try) and all(isinstance(x, (ast.Import, ast.ImportFrom)) for x in st.body):
            end = st.end_lineno
        else:
            break
    return end


def defined_names(st):
    if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {st.name}
    if isinstance(st, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split('.')[0] for a in st.names}
    return {t.id for t in ast.walk(st) if isinstance(t, ast.Name) and isinstance(t.ctx, ast.Store)}


def extract_constant(params):
    ws, path, text = open_file(params)
    src = Source(text)
    node = resolve_expression(params, text, src)
    check_constant(src, node)
    name = params['name']
    check_identifier(name)
    module_level = {n for st in src.tree.body for n in defined_names(st)}
    if name in module_level:
        raise Fail('name-exists', f"'{name}' is already defined in this module", name=name)
    targets = occurrences_in(src, src.tree, node) if params.get('similar') else [node]
    targets = [t for t in targets if t is node or not any(isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)) and set(free_names(t)) & local_names(a) for a in src.ancestors(t))]
    expr_text = src.segment(node)
    if '\n' in expr_text:
        expr_text = '(' + expr_text.strip() + ')' if not expr_text.lstrip().startswith(('(', '[', '{')) else expr_text
    # Where the constant goes: after the imports, but after any top-level statement defining a name it reads, and
    # before the statement holding the first use.
    top = lambda n: next((st for st in src.tree.body if n is st or n in set(ast.walk(st))), None)
    first_use = min(src.tree.body.index(top(t)) for t in targets)
    needs = set(free_names(node))
    after = import_block_end(src.tree)
    for i, st in enumerate(src.tree.body):
        if st.lineno > after and defined_names(st) & needs and i < first_use:
            after = st.end_lineno
    lines = text.split('\n')
    starts = line_starts(text)
    first_line_of_use = node_lines(src.tree.body[first_use])[0]
    insert_at = min(after, first_line_of_use - 1)  # lines kept above the constant
    k = insert_at
    while k < len(lines) and not lines[k].strip():
        k += 1
    # Join a run of simple assignments right below the insertion point instead of starting a new group.
    run_end = None
    if insert_at > 0 and k - insert_at <= 1:
        j = k
        for st in src.tree.body:
            if st.lineno == j + 1 and isinstance(st, (ast.Assign, ast.AnnAssign)) and st.end_lineno < first_line_of_use:
                run_end = j = st.end_lineno
    definition = f'{name} = {expr_text}\n'
    if run_end is not None:
        insertion = (starts[run_end] if run_end < len(starts) else len(text), definition)
    else:
        nxt = lines[k] if k < len(lines) else ''
        want = 2 if re.match(r'(async\s+def|def|class)\b|@', nxt) else 1
        lead = '\n' if insert_at > 0 and lines[insert_at - 1].strip() else ''
        gap = '\n' * max(0, want - (k - insert_at)) if nxt else ''
        insertion = (starts[insert_at] if insert_at < len(starts) else len(text), lead + definition + gap)
    edits = [(s, e, name) for s, e in (src.span(t) for t in targets)] + [(insertion[0], insertion[0], insertion[1])]
    new = text
    for s, e, t in sorted(edits, key=lambda x: (x[0], x[1]), reverse=True):
        new = new[:s] + t + new[e:]
    ws.write(path, new)
    return ws.result(f'Extract constant {name}', caret=caret_at(new, path, rf'^({re.escape(name)}) = '))


# ---------- Extract Parameter (ast) ----------
def parameter_insertion(src, func, name, default):
    """Text edit adding `name=default` after the last positional parameter (before *args, a bare * or **kwargs)."""
    a = func.args
    text = src.text
    open_paren = text.index('(', name_offset(src, func))
    new_param = f'{name}={default}'
    posonly = getattr(a, 'posonlyargs', [])
    positional = [*posonly, *a.args]
    defaults = dict(zip(positional[len(positional) - len(a.defaults):], a.defaults))

    def end_of(arg):
        if arg in defaults:
            return src.span(defaults[arg])[1]
        return src.span(arg.annotation)[1] if arg.annotation is not None else src.span(arg)[1]

    if a.args:
        return end_of(a.args[-1]), f', {new_param}'
    if posonly:
        return text.index('/', end_of(posonly[-1])) + 1, f', {new_param}'
    if a.vararg or a.kwonlyargs or a.kwarg:
        return text.index('*', open_paren), f'{new_param}, '
    return open_paren + 1, new_param


def inside_body(func, node):
    return any(node is st or node in set(ast.walk(st)) for st in func.body)


def extract_parameter(params):
    ws, path, text = open_file(params)
    src = Source(text)
    node = resolve_expression(params, text, src)
    func = parameter_function(src, node)
    name = params['name']
    check_identifier(name)
    if name in local_names(func):
        raise Fail('name-exists', f"'{name}' is already defined in this scope", name=name)
    targets = [t for t in occurrences_in(src, func, node) if inside_body(func, t)] if params.get('similar') else [node]
    default = src.segment(node)
    if '\n' in default:
        default = '(' + ' '.join(x.strip() for x in default.split('\n')) + ')'
    at, insertion = parameter_insertion(src, func, name, default)
    spans = [src.span(t) for t in targets]
    edits = [(s, e, name) for s, e in spans] + [(at, at, insertion)]
    new = text
    for s, e, t in sorted(edits, key=lambda x: (x[0], x[1]), reverse=True):
        new = new[:s] + t + new[e:]
    try:
        ast.parse(new)
    except SyntaxError as err:
        raise Fail('result-syntax', f'The result would not be valid Python (line {err.lineno})', line=err.lineno or 0)
    ws.write(path, new)
    def_off = position_of(new, at + (insertion.index(name)))
    return ws.result(f'Extract parameter {name}', caret={'path': path, **def_off})


# ---------- Extract Method (rope) ----------
def full_lines(text, s, e):
    """A selection that covers whole statements is widened to complete lines, as PyCharm does."""
    ls = text.rfind('\n', 0, s) + 1
    le = text.find('\n', e)
    le = len(text) if le < 0 else le
    head = text[ls:s]
    tail = text[e:le]
    multi = '\n' in text[s:e].rstrip('\n')
    if (not head.strip() and not tail.strip()) or multi:
        if text[s:e].endswith('\n'):
            return ls, e
        return ls, min(le + 1, len(text))
    return s, e


def extract_method(params):
    require_rope()
    ws, path, text = open_file(params)
    Source(text)  # reports syntax errors before rope does
    s, e = selection(params, text)
    if s == e:
        raise Fail('select-code', 'Select a code fragment to extract')
    s, e = full_lines(text, s, e)
    if not text[s:e].strip():
        raise Fail('select-code', 'Select a code fragment to extract')
    name = params['name']
    check_identifier(name)
    project = ws.project()
    try:
        changes = rope.refactor.extract.ExtractMethod(project, ws.resource(project, path), s, e).get_changes(
            name, similar=bool(params.get('similar')), global_=bool(params.get('global')))
        ws.absorb(changes)
    except Fail:
        raise
    except Exception as err:
        raise rope_fail(err)
    finally:
        project.close()
    new = space_definition(ws.texts[key(path)], name)
    ws.write(path, new)
    return ws.result(f'Extract method {name}', caret=caret_at(new, path, rf'^[ \t]*(?:async\s+)?def\s+({re.escape(name)})\('))


# ---------- Inline (rope) ----------
def inliner(ws, project, path, text, params):
    offset = offset_of(text, params['pos']['line'], params['pos']['col'])
    word = re.match(r'\w*', text[offset:]).group(0)
    if not word and offset and re.match(r'\w', text[offset - 1]):
        offset -= 1
    try:
        return rope.refactor.inline.create_inline(project, ws.resource(project, path), offset), offset
    except Exception as err:
        f = rope_fail(err)
        if f.code in ('no-target', 'rope'):
            raise Fail('no-inline-target', 'Caret should be positioned at a local variable, function or method to inline', detail=f.message)
        raise f


def prepare_inline(params):
    require_rope()
    ws, path, text = open_file(params)
    Source(text)
    project = ws.project()
    try:
        inl, offset = inliner(ws, project, path, text, params)
        kind = inl.get_kind()
        name = inl.name
        on_usage = False
        if kind == 'method':
            scope = inl.pyfunction.get_scope()
            line = text.count('\n', 0, offset) + 1
            on_usage = not (scope.get_start() <= line <= scope.get_end())
        elif kind == 'variable':
            line = text.count('\n', 0, offset) + 1
            assigned = inl.pyname.assignments[0].ast_node.lineno if getattr(inl.pyname, 'assignments', None) else None
            on_usage = assigned is not None and assigned != line
        return {'kind': kind, 'name': name, 'onUsage': on_usage}
    finally:
        project.close()


def inline(params):
    require_rope()
    ws, path, text = open_file(params)
    Source(text)
    project = ws.project()
    try:
        inl, _ = inliner(ws, project, path, text, params)
        kind = inl.get_kind()
        mode = params.get('mode', 'all')  # all | keep | this
        kwargs = {}
        if kind in ('method', 'variable'):
            kwargs = {'remove': mode == 'all', 'only_current': mode == 'this'}
        ws.absorb(inl.get_changes(**kwargs))
        name = inl.name
    except Fail:
        raise
    except Exception as err:
        raise rope_fail(err)
    finally:
        project.close()
    return ws.result(f'Inline {kind} {name}')


# ---------- Change Signature (rope) ----------
def function_at(src, offset):
    """The function whose name (or def line) holds the offset, else the call around the offset is not enough."""
    best = None
    for node in ast.walk(src.tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            s, _ = src.span(node)
            line_end = src.text.find(':', s)
            if s <= offset <= max(line_end, s) or node.lineno == src.text.count('\n', 0, offset) + 1:
                best = node
    return best


def name_offset(src, func):
    s = src.off(func.lineno, func.col_offset)
    m = re.compile(r'(?:async\s+)?def\s+').match(src.text, s)
    return m.end() if m else s


def signature_target(ws, path, text, params):
    src = Source(text)
    offset = offset_of(text, params['pos']['line'], params['pos']['col'])
    func = function_at(src, offset)
    if func is None:
        # On a call or a reference: let rope resolve the name under the caret.
        project = ws.project()
        try:
            cs = rope.refactor.change_signature.ChangeSignature(project, ws.resource(project, path), offset)
            pyfunc = cs.pyname.get_object()
            res = pyfunc.get_module().get_resource()
            target_path = res.real_path
            line = pyfunc.get_scope().get_start()
        except Exception as err:
            raise Fail('no-function', 'Caret should be positioned at the name of a function or method', detail=str(err))
        finally:
            project.close()
        tsrc = Source(ws.read(target_path))
        func = next(n for n in ast.walk(tsrc.tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == line)
        return target_path, tsrc, func
    return path, src, func


def is_method(src, func):
    return isinstance(src.parents.get(func), ast.ClassDef) and not any(
        isinstance(d, ast.Name) and d.id == 'staticmethod' for d in func.decorator_list)


def prepare_signature(params):
    require_rope()
    ws, path, text = open_file(params)
    target, src, func = signature_target(ws, path, text, params)
    ws.check_inside(target)
    project = ws.project()
    try:
        cs = rope.refactor.change_signature.ChangeSignature(project, ws.resource(project, target), name_offset(src, func))
        args = cs.get_args()
    except Exception as err:
        raise rope_fail(err)
    finally:
        project.close()
    hidden = 1 if is_method(src, func) and args and not args[0][0].startswith('*') else 0
    return {
        'name': func.name, 'path': target, 'line': func.lineno, 'hidden': [a[0] for a in args[:hidden]],
        'params': [{'name': n, 'default': d} for n, d in args[hidden:]],
        'kwonly': [a.arg for a in func.args.kwonlyargs],
    }


def locate_function(ws, path, line):
    src = Source(ws.read(path))
    for node in ast.walk(src.tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno == line:
            return src, node
    raise Fail('no-function', 'Caret should be positioned at the name of a function or method')


def rope_step(ws, fn):
    project = ws.project()
    try:
        ws.absorb(fn(project))
    except Fail:
        raise
    except Exception as err:
        raise rope_fail(err)
    finally:
        project.close()


def arg_node(func, name):
    a = func.args
    for arg in [*getattr(a, 'posonlyargs', []), *a.args, a.vararg, *a.kwonlyargs, a.kwarg]:
        if arg is not None and arg.arg == name.lstrip('*'):
            return arg
    return None


def change_signature(params):
    require_rope()
    ws, path, text = open_file(params)
    info = prepare_signature(params)
    target, line = info['path'], info['line']
    hidden = len(info['hidden'])
    old_params = info['params']
    new_params = params['params']
    new_name = params.get('name') or info['name']
    check_identifier(new_name)
    warnings = []
    seen = set()
    for p in new_params:
        bare = p['name'].lstrip('*')
        check_identifier(bare)
        if bare in seen:
            raise Fail('name-exists', f"'{bare}' is already defined in this scope", name=bare)
        seen.add(bare)

    src, func = locate_function(ws, target, line)
    body_names = {n.id for st in func.body for n in ast.walk(st) if isinstance(n, ast.Name)}
    kept = {p['old'] for p in new_params if p.get('old') is not None}
    for i, p in enumerate(old_params):
        if i not in kept and p['name'].lstrip('*') in body_names:
            warnings.append({'code': 'param-used', 'name': p['name'].lstrip('*')})

    # 1. Rename the function.
    if new_name != info['name']:
        rope_step(ws, lambda project: rope.refactor.rename.Rename(
            project, ws.resource(project, target), name_offset(src, func)).get_changes(new_name))
    # 2. Rename kept parameters (through temporary names when two swap names).
    renames = [(old_params[p['old']]['name'].lstrip('*'), p['name'].lstrip('*')) for p in new_params
               if p.get('old') is not None and old_params[p['old']]['name'].lstrip('*') != p['name'].lstrip('*')]
    old_names = {p['name'].lstrip('*') for p in old_params}
    if any(new in old_names for _, new in renames):
        staged = [(old, f'__pyide_tmp_{i}') for i, (old, _) in enumerate(renames)]
        renames = staged + [(f'__pyide_tmp_{i}', new) for i, (_, new) in enumerate(renames)]
    for old, new in renames:
        src, func = locate_function(ws, target, line)
        arg = arg_node(func, old)
        rope_step(ws, lambda project, arg=arg, new=new: rope.refactor.rename.Rename(
            project, ws.resource(project, target), src.span(arg)[0]).get_changes(new))
    # 3. Remove, add and reorder through rope's ChangeSignature (indices count the hidden self).
    cs = rope.refactor.change_signature
    changers = []
    current = list(range(len(old_params)))
    for i in sorted(set(current) - kept, reverse=True):
        changers.append(cs.ArgumentRemover(i + hidden))
        current.remove(i)
    order_keys = [('old', i) for i in current]
    for j, p in enumerate(new_params):
        if p.get('old') is None:
            changers.append(cs.ArgumentAdder(len(order_keys) + hidden, p['name'], p.get('default') or None, p.get('value') or None))
            order_keys.append(('new', j))
            if not p.get('default') and not p.get('value'):
                warnings.append({'code': 'no-value', 'name': p['name']})
    wanted = [('old', p['old']) if p.get('old') is not None else ('new', j) for j, p in enumerate(new_params)]
    if wanted != order_keys:
        changers.append(cs.ArgumentReorderer(list(range(hidden)) + [order_keys.index(k) + hidden for k in wanted]))
    if changers:
        src, func = locate_function(ws, target, line)
        rope_step(ws, lambda project: cs.ChangeSignature(
            project, ws.resource(project, target), name_offset(src, func)).get_changes(changers))
    # 4. Default values of kept parameters change in the definition only.
    src, func = locate_function(ws, target, line)
    text2 = src.text
    edits = []
    a = func.args
    positional = [*getattr(a, 'posonlyargs', []), *a.args]
    defaults = dict(zip(positional[len(positional) - len(a.defaults):], a.defaults))
    for p in new_params:
        if p.get('old') is None:
            continue
        old_default = old_params[p['old']]['default']
        new_default = p.get('default') or None
        if (old_default or None) == new_default:
            continue
        arg = arg_node(func, p['name'])
        if arg is None or arg not in positional:
            continue
        if arg in defaults:
            s = src.span(arg)[1] if arg.annotation is None else src.span(arg.annotation)[1]
            e = src.span(defaults[arg])[1]
            edits.append((s, e, f'={new_default}' if arg.annotation is None and new_default else f' = {new_default}' if new_default else ''))
        elif new_default:
            s = src.span(arg)[1] if arg.annotation is None else src.span(arg.annotation)[1]
            edits.append((s, s, f'={new_default}' if arg.annotation is None else f' = {new_default}'))
    for s, e, t in sorted(edits, reverse=True):
        text2 = text2[:s] + t + text2[e:]
    try:
        ast.parse(text2)
    except SyntaxError as err:
        raise Fail('result-syntax', f'The result would not be valid Python (line {err.lineno})', line=err.lineno or 0)
    ws.write(target, text2)
    return ws.result(f'Change signature of {info["name"]}', warnings=warnings)


# ---------- Move (rope) ----------
def module_name(root, path):
    rel = os.path.relpath(path, root)
    rel = re.sub(r'\.pyi?$', '', rel)
    parts = rel.replace('\\', '/').split('/')
    if parts[-1] == '__init__':
        parts = parts[:-1]
    return '.'.join(parts)


def top_level_at(src, offset):
    line = src.text.count('\n', 0, offset) + 1
    for st in src.tree.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            first, _ = node_lines(st)
            if first <= line <= st.lineno:
                return st
    return None


def move_source(params):
    """open_file for Move, whose target may be a folder (a package moved from the project tree)."""
    if not params.get('pos') and os.path.isdir(params.get('target') or ''):
        ws = Workspace(params['root'], params.get('overlay'))
        path = os.path.abspath(params['target'])
        ws.check_inside(path)
        return ws, path, ''
    return open_file(params)


def prepare_move(params):
    require_rope()
    ws, path, text = move_source(params)
    if params.get('pos'):
        src = Source(text)
        node = top_level_at(src, offset_of(text, params['pos']['line'], params['pos']['col']))
        if node is not None:
            return {'kind': 'global', 'name': node.name, 'path': path, 'module': module_name(ws.root, path),
                    'symbol': 'class' if isinstance(node, ast.ClassDef) else 'function'}
    target = os.path.abspath(params.get('target') or path)
    ws.check_inside(target)
    return {'kind': 'module', 'name': os.path.basename(target), 'path': target, 'module': module_name(ws.root, target),
            'folder': os.path.dirname(target)}


def move(params):
    require_rope()
    ws, path, text = move_source(params)
    info = prepare_move(params)
    dest = os.path.abspath(params['dest'])
    ws.check_inside(dest)
    if info['kind'] == 'global':
        if not dest.lower().endswith('.py'):
            raise Fail('dest-not-python', 'The destination must be a Python file')
        if key(dest) == key(path):
            raise Fail('same-destination', 'The destination is the same as the source')
        created = not os.path.exists(dest)
        made_dirs = []
        if created:
            d = os.path.dirname(dest)
            while not os.path.isdir(d):
                made_dirs.append(d)
                d = os.path.dirname(d)
            for d in reversed(made_dirs):
                os.mkdir(d)
            open(dest, 'w').close()
        try:
            src = Source(text)
            node = next(st for st in src.tree.body if getattr(st, 'name', None) == info['name'])
            dest_src = Source(ws.read(dest))
            if info['name'] in {n for st in dest_src.tree.body for n in defined_names(st)
                                if not isinstance(st, (ast.Import, ast.ImportFrom))}:
                raise Fail('name-exists', f"'{info['name']}' is already defined in {os.path.basename(dest)}",
                           name=info['name'])
            offset = name_offset(src, node) if not isinstance(node, ast.ClassDef) else src.text.index(node.name, src.off(node.lineno, node.col_offset))
            rope_step(ws, lambda project: rope.refactor.move.create_move(
                project, ws.resource(project, path), offset).get_changes(ws.resource(project, dest)))
        finally:
            if created:
                os.remove(dest)
                for d in made_dirs:
                    os.rmdir(d)
                ws.created.add(key(dest))
                ws.original[key(dest)] = None
        ws.write(dest, append_moved(ws.texts[key(dest)], info['name'], ws.original.get(key(dest)) or ''))
        return ws.result(f"Move {info['name']} to {module_name(ws.root, dest)}")
    # A module or package moves into a folder.
    if not os.path.isdir(dest):
        raise Fail('dest-not-folder', 'The destination must be a folder')
    source = info['path']
    if key(os.path.dirname(source)) == key(dest):
        raise Fail('same-destination', 'The destination is the same as the source')
    if os.path.exists(os.path.join(dest, os.path.basename(source))):
        raise Fail('dest-exists', f"{os.path.basename(source)} already exists in the destination",
                   name=os.path.basename(source))
    target = os.path.join(dest, os.path.basename(source))
    relative = absolutize_importers(ws, source)
    with namespace_init(source):
        rope_step(ws, lambda project: rope.refactor.move.MoveModule(
            project, ws.resource(project, source)).get_changes(ws.resource(project, dest)))
    relativize_importers(ws, relative, target)
    finish_module_change(ws, source, target, reorder=True)
    return ws.result(f"Move {info['module']} to {module_name(ws.root, dest) or '.'}")


# ---------- Rename a module or package (project tree), and helpers shared with Move ----------
class namespace_init:
    """Rope renames and moves only regular packages. While it analyses a namespace package (a folder of modules
    without __init__.py), the folder gets an empty __init__.py, which is removed again afterwards."""

    def __init__(self, path):
        init = os.path.join(path, '__init__.py')
        self.path = init if os.path.isdir(path) and not os.path.exists(init) else None

    def __enter__(self):
        if self.path:
            open(self.path, 'w').close()
        return self

    def __exit__(self, *exc):
        if self.path:
            try:
                os.remove(self.path)
            except OSError:
                pass
        return False


def code_lines(text):
    return [line.rstrip() for line in (text or '').split('\n') if line.strip()]


def import_bindings(st):
    if isinstance(st, ast.Import):
        return {a.asname or a.name.split('.')[0] for a in st.names}
    return {a.asname or a.name for a in st.names}


def import_block(text):
    """The top-level import statements of a module as [(node, source)] when they form one run of consecutive lines."""
    tree = ast.parse(text)
    lines = text.split('\n')
    stmts = [st for st in tree.body if isinstance(st, (ast.Import, ast.ImportFrom))]
    if not stmts:
        return [], 0, 0
    first, last = stmts[0].lineno, stmts[-1].end_lineno
    if sum(st.end_lineno - st.lineno + 1 for st in stmts) != last - first + 1:
        return None, 0, 0
    return [(st, '\n'.join(lines[st.lineno - 1:st.end_lineno])) for st in stmts], first, last


def restore_import_order(old, new):
    """Rope's MoveModule drops each rewritten import and adds its replacement at the end of the import block. This puts
    every replacement where the import it replaces was (matched by the names they bind, else in order), as PyCharm does."""
    try:
        olds, _, _ = import_block(old)
        news, first, last = import_block(new)
    except SyntaxError:
        return new
    if not olds or not news:
        return new
    old_texts = {t for _, t in olds}
    new_texts = {t for _, t in news}
    removed = [st for st, t in olds if t not in new_texts]
    added = [(st, t) for st, t in news if t not in old_texts]
    if not removed or not added or [t for _, t in olds if t in new_texts] != [t for _, t in news if t in old_texts]:
        return new
    free = list(range(len(added)))
    match = {}
    for i, st in enumerate(removed):
        j = next((j for j in free if import_bindings(added[j][0]) & import_bindings(st)), None)
        if j is not None:
            match[i] = [j]
            free.remove(j)
    for i in range(len(removed)):
        if i not in match:
            match[i] = [free.pop(0)] if free else []
    match[len(removed) - 1] = match[len(removed) - 1] + free
    order = []
    i = 0
    for _, t in olds:
        if t in new_texts:
            order.append(t)
        else:
            order.extend(added[j][1] for j in match[i])
            i += 1
    lines = new.split('\n')
    lines[first - 1:last] = '\n'.join(order).split('\n')
    return '\n'.join(lines)


def finish_module_change(ws, source, target, reorder=False):
    """Cleans up rope's module rename or move: changes that only touch blank lines are dropped (rope strips them in the
    moved module), imports keep their places, nothing is left for a temporary __init__.py, and the file or folder moves
    even when rope leaves that out."""
    temp = key(os.path.join(source, '__init__.py'))
    for k in list(ws.texts):
        old, new = ws.original.get(k), ws.texts[k]
        if k == temp or new == old or old is None:
            if k == temp:
                ws.texts[k] = old
            continue
        if code_lines(old) == code_lines(new):
            ws.texts[k] = old
        elif reorder:
            ws.texts[k] = restore_import_order(old, new)
    ws.moves = [(a, b) for a, b in ws.moves if key(a) != temp]
    if not any(key(a) == key(source) for a, _ in ws.moves):
        ws.moves.append((source, target))


# ---------- Move: importers keep their import style ----------
# Rope's MoveModule turns a relative `from .figures import area` (or `from . import figures`) into `import
# tools.figures` with qualified uses, and fails on `from ..pkg import mod`. Absolute `from` imports come through in
# their own style. So before rope runs, the relative imports that name the moved module are made absolute (in memory),
# and afterwards those imports, now naming the new place, become relative again where the new place is in the same
# top-level package as the importer, as PyCharm does.
# Dotted names are taken relative to rope's source folders (the project root, or `src` in a src layout), so they are
# the names rope itself resolves.
def source_folders(ws, project):
    """Rope's source folders, deepest first (the project root when rope finds none)."""
    if ws.sources is None:
        folders = {key(f.real_path): os.path.abspath(f.real_path) for f in project.get_source_folders()}
        ws.sources = sorted(folders.values(), key=len, reverse=True) or [ws.root]
    return ws.sources


def is_within(path, folder):
    return os.path.commonpath([key(path), key(folder)]) == key(folder)


def folders_holding(ws, path):
    """The source folders holding `path`, deepest first (the project root when none does)."""
    return [f for f in ws.sources or [] if is_within(path, f)] or [ws.root]


def import_name(ws, path, folder=None):
    """The dotted name `path` (a module file or package folder, existing or not) is imported by from `folder`, by
    default the deepest source folder holding it."""
    folder = folder or folders_holding(ws, path)[0]
    return '' if key(path) == key(folder) else module_name(folder, path)


def package_parts(ws, path, folder=None):
    """The package a module file is in, as a list of names (empty directly in the source folder)."""
    name = import_name(ws, os.path.dirname(os.path.abspath(path)), folder)
    return name.split('.') if name else []


def relative_target(path, level, module):
    """The file or folder (without .py) a relative `from` import in `path` names."""
    base = os.path.dirname(os.path.abspath(path))
    for _ in range(level - 1):
        base = os.path.dirname(base)
    return os.path.join(base, *module.split('.')) if module else base


def resolves_to(project, name, target):
    """Whether rope finds the module `name` at `target` (a folder, or a module file without .py)."""
    try:
        found = project.find_module(name)
    except Exception:
        return False
    return found is not None and key(found.real_path) in (key(target), key(target + '.py'))


def absolute_module(ws, project, path, level, module):
    """The absolute name rope resolves to what a relative `from` import in `path` names, trying each source folder
    holding `path` (deepest first), or None when there is none."""
    target = relative_target(path, level, module)
    for folder in folders_holding(ws, path):
        parts = package_parts(ws, path, folder)
        if level > len(parts):
            continue
        name = '.'.join(parts[:len(parts) - level + 1] + ([module] if module else []))
        if resolves_to(project, name, target):
            return name
    return None


def names_moved(path, node, source):
    """Whether a relative `from` import in `path` imports from, or imports, the module or package being moved."""
    moved = re.sub(r'\.pyi?$', '', os.path.abspath(source), flags=re.I)
    target = relative_target(path, node.level, node.module)
    return is_within(target, moved) or any(key(os.path.join(target, a.name)) == key(moved) for a in node.names)


def relative_module(ws, path, module):
    """`module` as seen from `path` with a relative import (`..pkg.mod`), or None outside the importer's package tree."""
    parts, target = package_parts(ws, path), module.split('.')
    common = 0
    while common < min(len(parts), len(target)) and parts[common] == target[common]:
        common += 1
    if not common:
        return None
    return '.' * (len(parts) - common + 1) + '.'.join(target[common:])


IMPORT_KEYWORD = re.compile(r'\bimport\b')


def from_module_edit(src, node, module):
    """Replaces the `from <module>` part of a from-import statement, keeping the imported names as they are written."""
    s, e = src.span(node)
    at = IMPORT_KEYWORD.search(src.text, s + 4, e)
    return s, at.start(), f'from {module} '


def apply_edits(text, edits):
    for s, e, new in sorted(edits, reverse=True):
        text = text[:s] + new + text[e:]
    return text


def bindings_of(node):
    return {a.asname or a.name for a in node.names}


def absolutize_importers(ws, source):
    """Makes the relative imports that name the module or package being moved absolute in ws.texts. Returns, per
    changed file, its text before rope, the names those imports bind and the modules they import from. A file with such
    an import that has no absolute name rope resolves to the same module is left to rope as it is."""
    project = ws.project()
    try:
        source_folders(ws, project)
        plan = {}
        for path in [r.real_path for r in project.get_python_files()]:
            if is_within(path, source):
                continue  # rope handles the moved module's own imports
            text = ws.read(path)
            if not re.search(r'^[ \t]*from[ \t]*\.', text, re.M):
                continue
            try:
                src = Source(text)
            except Fail:
                continue
            edits, binds, modules, resolved = [], set(), set(), True
            for node in ast.walk(src.tree):
                if not isinstance(node, ast.ImportFrom) or not node.level or not names_moved(path, node, source):
                    continue
                absolute = absolute_module(ws, project, path, node.level, node.module)
                if absolute is None:
                    resolved = False
                    break
                edits.append(from_module_edit(src, node, absolute))
                binds |= bindings_of(node)
                modules.add(absolute)
            if edits and resolved:
                text = apply_edits(text, edits)
                ws.texts[key(path)] = text
                plan[key(path)] = {'pre': text, 'bindings': binds, 'modules': modules}
        return plan
    finally:
        project.close()


def relativize_importers(ws, plan, target):
    """Turns the imports absolutize_importers made absolute back into relative ones, now naming the new place."""
    new = import_name(ws, target)
    for k, info in plan.items():
        text = ws.texts[k]
        if text == info['pre']:
            ws.texts[k] = ws.original[k]
            continue
        modules = set(info['modules']) | {new.rpartition('.')[0]}
        try:
            src = Source(text)
        except Fail:
            continue
        edits = []
        for node in ast.walk(src.tree):
            if (isinstance(node, ast.ImportFrom) and not node.level and node.module
                    and (node.module in modules or node.module == new or node.module.startswith(new + '.'))
                    and bindings_of(node) <= info['bindings']):
                relative = relative_module(ws, ws.real[k], node.module)
                if relative:
                    edits.append(from_module_edit(src, node, relative))
        ws.texts[k] = apply_edits(text, edits)


def rename_module(params):
    """Renames a module (a .py file) or a package (a folder, regular or namespace) and every import of it."""
    require_rope()
    ws = Workspace(params['root'], params.get('overlay'))
    target = os.path.abspath(params['target'])
    ws.check_inside(target)
    if key(target) == key(ws.root):
        raise Fail('outside-project', 'The project folder itself cannot be renamed')
    folder = os.path.isdir(target)
    name = (params.get('name') or '').strip()
    if not name:
        raise Fail('empty-name', 'Enter a name')
    new_mod = name if folder else re.sub(r'\.py$', '', name, flags=re.I)
    check_identifier(new_mod)
    if not folder and not target.lower().endswith('.py'):
        raise Fail('dest-not-python', 'Only Python modules are renamed with their references')
    new_path = os.path.join(os.path.dirname(target), new_mod if folder else new_mod + '.py')
    if key(new_path) == key(target) and os.path.basename(new_path) == os.path.basename(target):
        raise Fail('nothing', 'Nothing to change')
    if os.path.exists(new_path) and key(new_path) != key(target):
        raise Fail('dest-exists', f'{os.path.basename(new_path)} already exists', name=os.path.basename(new_path))
    old_module = module_name(ws.root, target)
    with namespace_init(target):
        rope_step(ws, lambda project: rope.refactor.rename.Rename(
            project, ws.resource(project, target)).get_changes(new_mod))
    finish_module_change(ws, target, new_path)
    ws.moves = [(a, new_path) if key(a) == key(target) else (a, b) for a, b in ws.moves]
    return ws.result(f'Rename {old_module} to {new_mod}')


def append_moved(text, name, original):
    """Rope inserts a moved definition after the destination's imports (or above its docstring); PyCharm appends it."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return text
    node = next((st for st in tree.body if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                 and st.name == name), None)
    if node is None:
        return text
    lines = text.split('\n')
    first, last = node_lines(node)
    block = lines[first - 1:last]
    rest = lines[:first - 1] + lines[last:]
    body = '\n'.join(rest).strip('\n')
    moved = '\n'.join(block)
    if not body:
        return moved + '\n'
    return body + '\n\n\n' + moved + '\n'


# ---------- dispatch ----------
METHODS = {
    'ping': lambda p: {'python': sys.version.split()[0], 'rope': load_rope()},
    'prepareExpression': prepare_expression,
    'extractVariable': extract_variable,
    'extractConstant': extract_constant,
    'extractParameter': extract_parameter,
    'extractMethod': extract_method,
    'prepareInline': prepare_inline,
    'inline': inline,
    'prepareSignature': prepare_signature,
    'changeSignature': change_signature,
    'prepareMove': prepare_move,
    'move': move,
    'renameModule': rename_module,
}


PATH_PARAMS = ('root', 'file', 'path', 'target', 'dest', 'source')


def long_paths(params):
    """A project opened through an 8.3 short path (C:\\Users\\RUNNER~1\\...) gets long paths from rope, which resolves
    its root with os.path.realpath, so nothing it returns would match the IDE's open files. Requests are made long here;
    the returned function maps results back to the IDE's spelling of the root."""
    root = params.get('root')
    if not isinstance(root, str) or not root:
        return params, lambda value: value
    ide_root, long_root = os.path.abspath(root), os.path.realpath(root)
    if os.path.normcase(ide_root) == os.path.normcase(long_root):
        return params, lambda value: value
    params = dict(params)
    for name in PATH_PARAMS:
        if isinstance(params.get(name), str) and params[name]:
            params[name] = os.path.realpath(params[name])
    if isinstance(params.get('overlay'), dict):
        params['overlay'] = {os.path.realpath(p): text for p, text in params['overlay'].items()}
    prefix = os.path.normcase(long_root)

    def back(value):
        if isinstance(value, dict):
            return {k: back(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [back(v) for v in value]
        if isinstance(value, str) and '\n' not in value and os.path.normcase(value[:len(long_root)]) == prefix \
                and value[len(long_root):len(long_root) + 1] in ('', '\\', '/'):
            return ide_root + value[len(long_root):]
        return value
    return params, back


def handle(msg):
    back = lambda value: value
    try:
        method = METHODS.get(msg.get('method'))
        if method is None:
            raise Fail('unknown-method', f"Unknown method {msg.get('method')}")
        params, back = long_paths(msg.get('params') or {})
        return {'id': msg.get('id'), 'result': back(method(params))}
    except Fail as f:
        return {'id': msg.get('id'), 'error': {'code': f.code, 'message': f.message, 'params': back(f.params)}}
    except Exception as err:
        return {'id': msg.get('id'), 'error': {'code': 'internal', 'message': f'{type(err).__name__}: {err}',
                                               'params': {'detail': traceback.format_exc()}}}


def main():
    stdin = open(sys.stdin.fileno(), 'r', encoding='utf-8', newline='\n')
    stdout = open(sys.stdout.fileno(), 'w', encoding='utf-8', newline='\n')
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        stdout.write(json.dumps(handle(msg)) + '\n')
        stdout.flush()


if __name__ == '__main__':
    main()
