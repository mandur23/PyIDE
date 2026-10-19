"""Stand-ins for wsl.exe, ssh and docker for verify/remote-interp.mjs.

make_launchers.py turns this into wsl.exe, ssh.exe and docker.exe (pip's console-script launcher) in a folder the
test puts first on PATH. Each fake models one kind of target on this machine: a POSIX path namespace mapped onto
local folders, a small sh interpreter for the scripts PyIDE sends, and the local Python standing in for the target's
python3. Whatever reaches a target must be a target path: a Windows path in an argument fails the command, so a
consumer that forgets to map a path fails its check. State lives in $PYIDE_FAKE_REMOTE_ROOT:

  wsl.json        {"distros": [{"name", "default"}]}                    /mnt/<d>/... is drive <d>:, / is fs/wsl-<name>
  ssh.json        {"hosts": {"<host>": {"user", "password"?}}}         / is fs/ssh-<host>, $HOME is /home/<user>
  docker.json     {"images": ["python:3.12-slim"], "services": ["web"]} / is fs/docker-<container>, plus -v mounts
  containers.json dev containers created with `docker run -d` / `docker compose run -d`
  calls.log       one JSON line per invocation
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.environ["PYIDE_FAKE_REMOTE_ROOT"]
PY = os.environ.get("PYIDE_FAKE_PYTHON") or sys.executable  # the targets' python3 (a venv of the test's own)
HERE = os.path.dirname(os.path.abspath(__file__))
PYTHONS = {"python", "python3", "/usr/bin/python3", "/usr/bin/python", "/usr/local/bin/python", "/usr/local/bin/python3"}
WINPATH = re.compile(r"^[A-Za-z]:[\\/]")


def load(name, default):
    try:
        with open(os.path.join(ROOT, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, data):
    with open(os.path.join(ROOT, name), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


def log(kind, argv):
    with open(os.path.join(ROOT, "calls.log"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"tool": kind, "argv": argv, "time": time.time()}) + "\n")


def err(text):
    sys.stderr.write(text if text.endswith("\n") else text + "\n")
    sys.stderr.flush()


def python_prefixes():
    info = load("python.json", None)
    if not info or info.get("python") != PY:
        out = subprocess.run([PY, "-c", "import sys; print(sys.prefix); print(sys.base_prefix)"], capture_output=True, text=True).stdout.split("\n")
        info = {"python": PY, "prefixes": [out[0].strip(), out[1].strip()]}
        save("python.json", info)
    return info["prefixes"]


class Namespace:
    """A target's filesystem: [(posix prefix, local folder)], longest prefix wins, plus port translations."""

    def __init__(self, name, mounts, home="/root", ports=None, drives=False):
        self.name = name
        # Every target has the stand-in Python installed: its venv at /usr/local/pyvenv, the base install at
        # /usr/local/python (what a Linux python3's sys.path, prefix and site-packages would look like).
        prefixes = python_prefixes()
        mounts = list(mounts) + [("/usr/local/pyvenv", prefixes[0]), ("/usr/local/python", prefixes[1])]
        self.mounts = sorted(mounts, key=lambda m: -len(m[0]))
        self.home = home
        self.ports = ports or {}
        self.drives = drives
        os.makedirs(self.local("/tmp"), exist_ok=True)
        os.makedirs(self.local(home), exist_ok=True)

    def local(self, p):
        if self.drives:
            m = re.match(r"^/mnt/([a-z])(/.*)?$", p)
            if m:
                return m.group(1).upper() + ":" + (m.group(2) or "/").replace("/", "\\")
        for prefix, folder in self.mounts:
            if p == prefix or p.startswith(prefix.rstrip("/") + "/"):
                rest = p[len(prefix):].lstrip("/")
                return os.path.join(folder, *rest.split("/")) if rest else folder
        raise ValueError(p)

    def remote(self, local):
        """Local path -> target path, for output (tracebacks, test reports)."""
        n = os.path.normcase(os.path.abspath(local))
        for prefix, folder in self.mounts:
            f = os.path.normcase(os.path.abspath(folder))
            if n == f or n.startswith(f.rstrip("\\") + "\\"):
                rest = local[len(f):].replace("\\", "/").lstrip("/")
                return prefix.rstrip("/") + "/" + rest if rest else prefix
        if self.drives and re.match(r"^[A-Za-z]:\\", local):
            return "/mnt/" + local[0].lower() + local[2:].replace("\\", "/")
        return None

    def localize_output(self, text):
        """Rewrites local paths in a line of output as target paths."""
        def repl(m):
            r = self.remote(m.group(0))
            return r if r else m.group(0)
        return re.sub(r"[A-Za-z]:\\[^\"'\n:]*", repl, text)


# ---------------------------------------------------------------- sh

class Exit(Exception):
    def __init__(self, code):
        self.code = code


def tokenize(script, env):
    """Words and operators of a POSIX sh script, with quoting and $ expansions done. Words carry a flag telling
    whether they came from an unquoted assignment-capable word (unused) — kept simple on purpose."""
    tokens = []
    i, n = 0, len(script)
    word, has_word = [], False

    def expand(s, j):
        # s[j] == '$'; returns (text, next index)
        if j + 1 < len(s) and s[j + 1] == "$":
            return str(env.get("$$", os.getpid())), j + 2
        if j + 1 < len(s) and s[j + 1] == "{":
            end = s.index("}", j)
            expr = s[j + 2:end]
            if ":-" in expr:
                name, default = expr.split(":-", 1)
                return env.get(name) or default, end + 1
            return env.get(expr, ""), end + 1
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", s[j + 1:])
        if m:
            return env.get(m.group(0), ""), j + 1 + len(m.group(0))
        return "$", j + 1

    def flush():
        nonlocal word, has_word
        if has_word:
            tokens.append(("w", "".join(word)))
        word, has_word = [], False

    while i < n:
        c = script[i]
        if c in " \t":
            flush()
            i += 1
        elif c == "\n" or c == ";":
            flush()
            tokens.append(("op", ";"))
            i += 1
        elif script.startswith("&&", i) or script.startswith("||", i):
            flush()
            tokens.append(("op", script[i:i + 2]))
            i += 2
        elif c == "'":
            end = script.index("'", i + 1)
            word.append(script[i + 1:end])
            has_word = True
            i = end + 1
        elif c == '"':
            i += 1
            has_word = True
            while script[i] != '"':
                if script[i] == "\\" and script[i + 1] in '"\\$`':
                    word.append(script[i + 1])
                    i += 2
                elif script[i] == "$":
                    text, i = expand(script, i)
                    word.append(text)
                else:
                    word.append(script[i])
                    i += 1
            i += 1
        elif c == "\\" and i + 1 < n:
            word.append(script[i + 1])
            has_word = True
            i += 2
        elif c == "$":
            text, i = expand(script, i)
            word.append(text)
            has_word = True
        elif c in "<>" or (c.isdigit() and not has_word and i + 1 < n and script[i + 1] in "<>"):
            flush()
            m = re.match(r"(\d?)(>>|>&|<&|>|<)\s*(&?\d+|[^\s;&|]+)", script[i:])
            tokens.append(("redir", (m.group(1) or ("0" if m.group(2)[0] == "<" else "1"), m.group(2), m.group(3))))
            i += len(m.group(0))
        else:
            word.append(c)
            has_word = True
            i += 1
    flush()
    return tokens


class Shell:
    def __init__(self, ns, kind, env=None, cwd=None):
        self.ns = ns
        self.kind = kind
        self.env = {"HOME": ns.home, "PATH": "/usr/local/bin:/usr/bin:/bin", "SHELL": "/bin/bash", "$$": os.getpid()}
        self.env.update(env or {})
        self.cwd = cwd or ns.home

    def run(self, script):
        tokens = tokenize(script, self.env)
        code, op, cmd = 0, ";", []
        for t in tokens + [("op", ";")]:
            if t[0] != "op":
                cmd.append(t)
                continue
            if cmd and (op == ";" or (op == "&&" and code == 0) or (op == "||" and code != 0)):
                code = self.command(cmd)
            cmd, op = [], t[1]
        return code

    def command(self, toks):
        words = [t[1] for t in toks if t[0] == "w"]
        redirs = [t[1] for t in toks if t[0] == "redir"]
        out, errs, fd3 = sys.stdout, sys.stderr, False
        for fd, op, target in redirs:
            if op == ">&" and fd == "1" and target == "2":
                out = sys.stderr
            elif op == ">&" and fd == "2" and target == "1":
                errs = sys.stdout
            elif op == ">&" and fd == "3" and target == "2":
                fd3 = True
            elif op == ">" and target == "/dev/null":
                if fd == "1":
                    out = open(os.devnull, "w")
                elif fd == "2":
                    errs = open(os.devnull, "w")
        if not words:
            return 0
        if words[0] == "exec":
            words = words[1:]
            if not words:
                return 0
        return self.builtin(words, out, errs, fd3)

    def builtin(self, words, out, errs, fd3):
        name, args = words[0], words[1:]
        if name == "cd":
            target = self.abspath(args[0] if args else self.ns.home)
            try:
                ok = os.path.isdir(self.ns.local(target))
            except ValueError:
                ok = False
            if not ok:
                errs.write("sh: cd: can't cd to %s\n" % (args[0] if args else ""))
                return 2
            self.cwd = target
            return 0
        if name == "pwd":
            out.write(self.cwd + "\n")
            out.flush()
            return 0
        if name in ("true", ":"):
            return 0
        if name == "exit":
            raise Exit(int(args[0]) if args else 0)
        if name == "echo":
            out.write(" ".join(args) + "\n")
            out.flush()
            return 0
        if name == "printf":
            fmt = args[0].replace("\\n", "\n")
            fmt = re.sub(r"\\0?([0-7]{1,3})", lambda m: chr(int(m.group(1), 8)), fmt)
            parts = fmt.split("%s")
            values = args[1:] + [""] * len(parts)
            out.write("".join(p + (values[i] if i < len(parts) - 1 else "") for i, p in enumerate(parts)))
            out.flush()
            return 0
        if name == "sleep":
            time.sleep(float(args[0]))
            return 0
        if name == "command" and args[:1] == ["-v"]:
            what = args[1]
            found = {"python3": "/usr/bin/python3", "python": "/usr/bin/python3", "sh": "/bin/sh", "bash": "/bin/bash",
                     "wslpath": "/usr/bin/wslpath"}.get(what) or (what if what in PYTHONS else None)
            if found and not (what == "wslpath" and self.kind != "wsl"):
                out.write(found + "\n")
                return 0
            return 1
        if name == "wslpath" and self.kind == "wsl":
            p = args[-1]
            out.write("/mnt/" + p[0].lower() + "/" + p[3:].replace("\\", "/") + "\n")
            return 0
        if name == "kill":
            pid = args[-1]
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)
            return 0
        if name == "env":
            env = {}
            while args and "=" in args[0] and not args[0].startswith("/"):
                k, v = args[0].split("=", 1)
                env[k] = v
                args = args[1:]
            saved = dict(self.env)
            self.env.update(env)
            try:
                return self.builtin(args, out, errs, fd3)
            finally:
                self.env = saved
        if name in ("sh", "bash", "/bin/sh", "/bin/bash") or name == self.env.get("SHELL"):
            if args[:1] == ["-c"]:
                return Shell(self.ns, self.kind, self.user_env(), self.cwd).run(args[1])
            return Shell(self.ns, self.kind, self.user_env(), self.cwd).interactive()
        if name in PYTHONS:
            return self.python(args, out, errs, fd3)
        errs.write("sh: %s: not found\n" % name)
        return 127

    def user_env(self):
        return {k: v for k, v in self.env.items() if k != "$$"}

    def abspath(self, p):
        if p.startswith("/"):
            return p
        if p.startswith("~"):
            return self.ns.home + p[1:]
        return (self.cwd.rstrip("/") + "/" + p) if p != "." else self.cwd

    def map_arg(self, a):
        if WINPATH.match(a):
            raise ValueError("Windows path passed to the target: " + a)
        m = re.match(r"^(0\.0\.0\.0|127\.0\.0\.1|localhost):(\d+)$", a)
        if m and int(m.group(2)) in self.ns.ports:
            return "127.0.0.1:%d" % self.ns.ports[int(m.group(2))]
        if a.startswith("/") and len(a) > 1:
            if "::" in a:  # pytest node id: path::Class::test
                path, rest = a.split("::", 1)
                return self.ns.local(path) + "::" + rest
            return self.ns.local(a)
        return a

    def python(self, args, out, errs, fd3):
        sys.stdout.flush()
        sys.stderr.flush()
        env = dict(os.environ)
        for k in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
            env.pop(k, None)
        report = None
        try:
            mapped = [self.map_arg(a) for a in args]
            for k, v in self.user_env().items():
                if k == "PYTHONPATH":
                    env[k] = ";".join(self.ns.local(p) for p in str(v).split(":") if p)
                elif k == "PYIDE_TEST_REPORT" and v == "fd:3":
                    if not fd3:
                        raise ValueError("PYIDE_TEST_REPORT=fd:3 without a 3>&2 redirection")
                    fd, report = tempfile.mkstemp(prefix="fake-fd3-", suffix=".jsonl")
                    os.close(fd)
                    env[k] = report
                elif isinstance(v, str) and WINPATH.match(v):
                    raise ValueError("Windows path in %s for the target: %s" % (k, v))
                elif k not in ("HOME", "PATH", "SHELL"):
                    env[k] = str(v)
            cwd = self.ns.local(self.cwd)
        except ValueError as e:
            errs.write("fake %s: %s\n" % (self.kind, e))
            return 127
        env["FAKE_TARGET"] = "%s:%s" % (self.kind, self.ns.name)
        argv = [PY] + mapped
        if "-m" in mapped and mapped[mapped.index("-m") + 1:mapped.index("-m") + 2] == ["debugpy"]:
            # The target sees /mnt/c/... or /opt/project/...; pydevd here sees the local files behind them.
            i = mapped.index("-m")
            argv = [PY] + mapped[:i] + [os.path.join(HERE, "debug_shim.py")] + mapped[i + 2:]
            env["FAKE_MOUNTS"] = json.dumps(self.ns.mounts + ([["/mnt/c", "C:\\"]] if self.ns.drives else []))
        stop = threading.Event()
        # PyIDE's `libs` helper reports the interpreter's folders: as the target, report them as target paths.
        libs = "-c" in mapped and "target-side helper" in mapped[mapped.index("-c") + 1] and mapped[mapped.index("-c") + 2:][:1] == ["libs"]
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE if libs else None if out is sys.stdout else out,
                                stderr=subprocess.PIPE)
        if libs:
            info = json.loads(proc.stdout.read())
            info["paths"] = [self.ns.remote(p) or p for p in info["paths"]]
            info["prefix"] = self.ns.remote(info["prefix"]) or info["prefix"]
            out.write(json.dumps(info))
            out.flush()
        relay = threading.Thread(target=self.relay_err, args=(proc.stderr, errs), daemon=True)
        relay.start()
        tail = None
        if report:
            tail = threading.Thread(target=self.tail_report, args=(report, errs, stop), daemon=True)
            tail.start()
        code = proc.wait()
        relay.join(5)
        if tail:
            stop.set()
            tail.join(5)
            os.remove(report)
        return code

    def relay_err(self, stream, errs):
        # Tracebacks name the files the target ran: rewrite local paths as target paths, line by line.
        buf = b""
        while True:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(1)
            if not chunk:
                break
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                errs.write(self.ns.localize_output(line.decode("utf-8", "replace")) + "\n")
            if buf and not buf.startswith(b"\x1e"):
                errs.write(buf.decode("utf-8", "replace"))
                buf = b""
            errs.flush()
        if buf:
            errs.write(buf.decode("utf-8", "replace"))
            errs.flush()

    def tail_report(self, report, errs, stop):
        pos = 0
        while True:
            done = stop.is_set()
            with open(report, "rb") as f:
                f.seek(pos)
                data = f.read()
            end = data.rfind(b"\n") + 1
            # Not splitlines(): it also breaks at \x1e, the marker's first character.
            for line in data[:end].decode("utf-8").replace("\r\n", "\n").split("\n")[:-1]:
                mark = line.startswith("\x1e")
                body = line[line.index(" ") + 1:] if mark else line
                ev = json.loads(body)
                for t in ev.get("tests", []):
                    if t.get("file"):
                        t["file"] = self.ns.remote(t["file"]) or t["file"]
                errs.write(("\x1ePYIDE-TEST " if mark else "") + json.dumps(ev) + "\n")
                errs.flush()
            pos += end
            if done:
                return
            time.sleep(0.05)

    def interactive(self):
        while True:
            sys.stdout.write("fake@%s:%s$ " % (self.ns.name, self.cwd))
            sys.stdout.flush()
            line = sys.stdin.readline()
            if not line:
                return 0
            try:
                self.run(line.strip())
            except Exit as e:
                return e.code
            except Exception as e:  # a typo in the terminal must not end the session
                err("sh: %s" % e)


# ---------------------------------------------------------------- tools

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def forward(local_port, remote_port):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", local_port))
    srv.listen(5)

    def pipe(a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                b.sendall(d)
        except OSError:
            pass
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def serve():
        while True:
            c, _ = srv.accept()
            try:
                r = socket.create_connection(("127.0.0.1", remote_port))
            except OSError:
                c.close()  # like ssh: the tunnel accepts, the channel fails
                continue
            threading.Thread(target=pipe, args=(c, r), daemon=True).start()
            threading.Thread(target=pipe, args=(r, c), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()


def fs(name):
    p = os.path.join(ROOT, "fs", name)
    os.makedirs(p, exist_ok=True)
    return p


def wsl(argv):
    cfg = load("wsl.json", {"distros": []})
    if argv[:2] == ["-l", "-v"]:
        if not cfg["distros"]:
            sys.stdout.buffer.write("Windows Subsystem for Linux has no installed distributions.\r\n".encode("utf-16le"))
            return 4294967295 & 0xFF
        rows = ["  NAME            STATE           VERSION"]
        rows += ["%s %-15s Running         2" % ("*" if d.get("default") else " ", d["name"]) for d in cfg["distros"]]
        sys.stdout.buffer.write(("\r\n".join(rows) + "\r\n").encode("utf-16le"))
        return 0
    distro, cwd, cmd = None, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-d", "--distribution"):
            distro = argv[i + 1]
            i += 2
        elif a == "--cd":
            cwd = argv[i + 1]
            i += 2
        elif a in ("--exec", "-e", "--"):
            cmd = argv[i + 1:]
            break
        else:
            err("fake wsl: unsupported argument %s" % a)
            return 1
    names = [d["name"] for d in cfg["distros"]]
    distro = distro or next((d["name"] for d in cfg["distros"] if d.get("default")), None)
    if distro not in names:
        err("There is no distribution with the supplied name.")
        return 1
    ns = Namespace(distro, [("/", fs("wsl-" + distro))], home="/home/fake", drives=True)
    sh = Shell(ns, "wsl", cwd="/home/fake")
    if cwd:
        if WINPATH.match(cwd):
            err("fake wsl: --cd expects a Linux path, got " + cwd)
            return 1
        sh.cwd = cwd
    if cmd is None:
        return sh.interactive()
    return sh.builtin(cmd, sys.stdout, sys.stderr, False)


def ssh(argv):
    cfg = load("ssh.json", {"hosts": {}})
    opts, i, forwards, user, port = {}, 0, [], None, 22
    while i < len(argv) and argv[i].startswith("-"):
        a = argv[i]
        if a == "-o":
            k, v = argv[i + 1].split("=", 1)
            opts[k.lower()] = v
            i += 2
        elif a == "-L":
            parts = argv[i + 1].split(":")
            forwards.append((int(parts[-3]), int(parts[-1])))
            i += 2
        elif a == "-l":
            user = argv[i + 1]
            i += 2
        elif a == "-p":
            port = int(argv[i + 1])
            i += 2
        elif a in ("-i", "-F"):
            i += 2
        else:
            i += 1
    dest = argv[i]
    command = " ".join(argv[i + 1:])
    if "@" in dest:
        user, dest = dest.split("@", 1)
    host = cfg["hosts"].get(dest)
    if host is None:
        err("ssh: Could not resolve hostname %s: No such host is known." % dest)
        return 255
    user = user or host.get("user", "fake")
    if host.get("port", 22) != port:
        err("ssh: connect to host %s port %d: Connection refused" % (dest, port))
        return 255
    if host.get("password"):
        ask = os.environ.get("SSH_ASKPASS")
        if opts.get("batchmode") == "yes" or not ask or os.environ.get("SSH_ASKPASS_REQUIRE") != "force":
            err("%s@%s: Permission denied (publickey,password)." % (user, dest))
            return 255
        r = subprocess.run([ask, "%s@%s's password: " % (user, dest)], capture_output=True, text=True)
        if r.returncode != 0 or r.stdout.rstrip("\r\n") != host["password"]:
            err("Permission denied, please try again.\n%s@%s: Permission denied (publickey,password)." % (user, dest))
            return 255
    for local, remote in forwards:
        forward(local, remote)
    home = "/home/" + user
    ns = Namespace(dest, [("/", fs("ssh-" + dest))], home=home)
    sh = Shell(ns, "ssh", {"USER": user}, cwd=home)
    try:
        return sh.run(command) if command.strip() else sh.interactive()
    except Exit as e:
        return e.code


def container_ns(name, c):
    mounts = [(dst, src) for src, dst in c["mounts"]] + [("/", fs("docker-" + name))]
    return Namespace(name, mounts, home="/root", ports={int(k): v for k, v in c.get("ports", {}).items()})


def docker_run(argv, image_from=None):
    """docker run / docker compose run: [opts] IMAGE|SERVICE [cmd...]"""
    c = {"mounts": [], "ports": {}, "labels": [], "workdir": "/", "entrypoint": None, "detach": False, "name": None}
    i = 0
    flags_with_value = {"--name", "--label", "-l", "-v", "--volume", "-p", "--publish", "-w", "--workdir", "--entrypoint", "-e"}
    while i < len(argv) and argv[i].startswith("-"):
        a = argv[i]
        v = argv[i + 1] if a in flags_with_value else None
        if a in ("-d", "--detach"):
            c["detach"] = True
        elif a == "--name":
            c["name"] = v
        elif a in ("--label", "-l"):
            c["labels"].append(v)
        elif a in ("-v", "--volume"):
            m = re.match(r"^(.*):(/[^:]*)(:ro|:rw)?$", v)
            c["mounts"].append([m.group(1), m.group(2)])
        elif a in ("-p", "--publish"):
            c["ports"][int(v.rsplit(":", 1)[1])] = free_port()
        elif a in ("-w", "--workdir"):
            c["workdir"] = v
        elif a == "--entrypoint":
            c["entrypoint"] = v
        i += 2 if v is not None else 1
    image = argv[i]
    cmd = argv[i + 1:]
    known = load("docker.json", {"images": [], "services": []})
    if image_from == "compose" and image not in known["services"]:
        err("no such service: %s" % image)
        return 1
    if image_from != "compose" and image not in known["images"]:
        err("Unable to find image '%s' locally\ndocker: Error response from daemon: pull access denied for %s." % (image, image))
        return 125
    words = ([c["entrypoint"]] if c["entrypoint"] else []) + cmd
    if c["detach"]:
        name = c["name"] or "c%d" % int(time.time())
        containers = load("containers.json", {})
        containers[name] = {"image": image, "mounts": c["mounts"], "ports": c["ports"], "labels": c["labels"], "running": True,
                            "workdir": c["workdir"]}
        save("containers.json", containers)
        print(name)
        return 0
    ns = container_ns("run-%s" % re.sub(r"\W", "-", image), {"mounts": c["mounts"], "ports": {}})
    sh = Shell(ns, "docker", cwd=c["workdir"])
    try:
        return sh.builtin(words, sys.stdout, sys.stderr, False)
    except Exit as e:
        return e.code


def docker(argv):
    containers = load("containers.json", {})
    if argv[:1] == ["version"]:
        if not load("docker.json", {}).get("daemon", True):
            print(json.dumps({"Client": {"Version": "27.3.1"}, "Server": None}))
            err("Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?")
            return 1
        print(json.dumps({"Client": {"Version": "27.3.1"}, "Server": {"Version": "27.3.1-fake"}}))
        return 0
    if argv[:1] == ["images"]:
        for im in load("docker.json", {"images": []})["images"]:
            repo, tag = im.split(":", 1)
            print(json.dumps({"Repository": repo, "Tag": tag}))
        return 0
    if argv[:2] == ["compose", "version"]:
        print("2.30.3")
        return 0
    if argv[:1] == ["compose"]:
        i = 1
        while argv[i] != "run":
            i += 2 if argv[i] in ("-f", "--file", "-p") else 1
        rest = [a for a in argv[i + 1:] if a != "--no-deps" and a != "--rm"]
        return docker_run(rest, image_from="compose")
    if argv[:1] == ["run"]:
        return docker_run([a for a in argv[1:] if a not in ("--rm", "--init", "-i", "-t", "-it")])
    if argv[:1] == ["inspect"]:
        c = containers.get(argv[-1])
        if not c:
            err("Error: No such object: " + argv[-1])
            return 1
        print("true" if c["running"] else "false")
        return 0
    if argv[:1] in (["start"], ["stop"], ["kill"]):
        for name in [a for a in argv[1:] if not a.startswith("-") and not a.isdigit()]:
            if name in containers:
                containers[name]["running"] = argv[0] == "start"
        save("containers.json", containers)
        return 0
    if argv[:1] == ["rm"]:
        for name in [a for a in argv[1:] if not a.startswith("-")]:
            containers.pop(name, None)
        save("containers.json", containers)
        return 0
    if argv[:1] == ["ps"]:
        label = argv[argv.index("--filter") + 1].split("=", 1)[1] if "--filter" in argv else None
        for name, c in containers.items():
            if not label or label in c.get("labels", []):
                print(name)
        return 0
    if argv[:1] == ["port"]:
        c = containers.get(argv[1])
        port = argv[2].split("/")[0]
        if not c or port not in c["ports"]:
            err("Error: No public port '%s' published for %s" % (argv[2], argv[1]))
            return 1
        print("127.0.0.1:%d" % c["ports"][port])
        return 0
    if argv[:1] == ["exec"]:
        i, workdir = 1, None
        while argv[i].startswith("-"):
            if argv[i] in ("-w", "--workdir"):
                workdir = argv[i + 1]
                i += 2
            else:
                i += 1
        name = argv[i]
        c = containers.get(name)
        if not c or not c["running"]:
            err("Error response from daemon: container %s is not running" % name)
            return 1
        sh = Shell(container_ns(name, c), "docker", cwd=workdir or c.get("workdir") or "/")
        try:
            return sh.builtin(argv[i + 1:], sys.stdout, sys.stderr, False)
        except Exit as e:
            return e.code
    err("fake docker: unsupported command %s" % " ".join(argv))
    return 1


def main(tool):
    argv = sys.argv[1:]
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(newline="\n", encoding="utf-8")  # a Linux target writes LF and UTF-8
    log(tool, argv)
    try:
        code = {"wsl": wsl, "ssh": ssh, "docker": docker}[tool](argv)
    except Exit as e:
        code = e.code
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code or 0)
