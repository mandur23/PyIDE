"""Jupyter kernel bridge for PyIDE notebooks.

Runs in the project interpreter, starts an ipykernel through jupyter_client and talks to the IDE in JSON lines:
requests arrive on stdin ({"op": ...}), events leave on stdout ({"ev": ...}). One thread owns every ZMQ socket;
a reader thread only queues stdin lines, because ZMQ sockets must not be shared between threads.
"""
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time

_out_lock = threading.Lock()


def emit(**msg):
    line = json.dumps(msg, ensure_ascii=False, default=str)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


try:
    import ipykernel  # noqa: F401  (the kernel itself runs `python -m ipykernel_launcher`)
    import zmq
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpecManager
except ImportError as exc:
    emit(ev="fatal", kind="missing", module=(exc.name or "ipykernel").split(".")[0], python=sys.executable, message=str(exc))
    sys.exit(0)

OUTPUT_TYPES = {"stream", "display_data", "execute_result", "error"}


class Bridge:
    def __init__(self, cwd, paths):
        self.cwd = cwd
        self.paths = paths
        self.commands = queue.Queue()
        self.requests = {}  # kernel msg_id -> (kind, our request id)
        self.last_exec = None  # our id of the last execute request, for output that arrives without a known parent
        self.spec_dir = tempfile.mkdtemp(prefix="pyide-kernelspec-")
        self.km = None
        self.kc = None
        self.poller = None
        self.dead_reported = False

    # ---------- kernel lifecycle ----------
    def _kernel_manager(self):
        # A private kernelspec pins the kernel to this interpreter; a user-installed "python3" spec could point elsewhere.
        spec = os.path.join(self.spec_dir, "pyide")
        os.makedirs(spec, exist_ok=True)
        launcher = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernel_launcher.py")
        with open(os.path.join(spec, "kernel.json"), "w", encoding="utf-8") as f:
            json.dump({"argv": [sys.executable, launcher, "-f", "{connection_file}"],
                       "display_name": "Python 3 (PyIDE)", "language": "python"}, f)
        ksm = KernelSpecManager(kernel_dirs=[self.spec_dir])
        return KernelManager(kernel_spec_manager=ksm, kernel_name="pyide")

    def _env(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([*self.paths, *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env.setdefault("PYDEVD_DISABLE_FILE_VALIDATION", "1")
        env["PYTHONIOENCODING"] = "utf-8"
        env.pop("PYTHONUNBUFFERED", None)
        return env

    def _connect(self):
        self.kc = self.km.client()
        self.kc.allow_stdin = True
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self.poller = zmq.Poller()
        for ch in (self.kc.iopub_channel, self.kc.shell_channel, self.kc.stdin_channel):
            self.poller.register(ch.socket, zmq.POLLIN)

    def start(self):
        self.km = self._kernel_manager()
        self.km.start_kernel(cwd=self.cwd, env=self._env())
        self._connect()
        self.dead_reported = False
        emit(ev="ready", python=sys.executable, version=sys.version.split()[0], pid=self._pid())

    def _pid(self):
        try:
            return self.km.provisioner.process.pid
        except Exception:
            return None

    def restart(self):
        self.kc.stop_channels()
        self.requests.clear()
        self.km.restart_kernel(now=True)
        self._connect()
        self.dead_reported = False
        emit(ev="restarted", pid=self._pid())

    def shutdown(self):
        try:
            if self.kc:
                self.kc.stop_channels()
            if self.km and self.km.has_kernel:
                self.km.shutdown_kernel(now=True)
        finally:
            shutil.rmtree(self.spec_dir, ignore_errors=True)

    # ---------- requests from the IDE ----------
    def handle(self, cmd):
        op = cmd.get("op")
        rid = cmd.get("id")
        if op == "execute":
            msg_id = self.kc.execute(cmd["code"], store_history=True, allow_stdin=True, stop_on_error=True)
            self.requests[msg_id] = ("execute", rid)
            self.last_exec = rid
        elif op == "complete":
            self.requests[self.kc.complete(cmd["code"], cmd["pos"])] = ("complete", rid)
        elif op == "inspect":
            self.requests[self.kc.inspect(cmd["code"], cmd["pos"], detail_level=cmd.get("detail", 0))] = ("inspect", rid)
        elif op == "input":
            self.kc.input(cmd.get("value", ""))
        elif op == "interrupt":
            self.km.interrupt_kernel()
        elif op == "restart":
            self.restart()
        elif op == "shutdown":
            return False
        return True

    # ---------- messages from the kernel ----------
    def _owner(self, msg):
        parent = msg.get("parent_header", {}).get("msg_id")
        entry = self.requests.get(parent)
        return entry[1] if entry else self.last_exec

    def on_iopub(self, msg):
        kind = msg["header"]["msg_type"]
        content = msg["content"]
        if kind == "status":
            emit(ev="status", state=content.get("execution_state"))
        elif kind == "execute_input":
            emit(ev="count", id=self._owner(msg), n=content.get("execution_count"))
        elif kind in OUTPUT_TYPES:
            out = {"output_type": kind}
            if kind == "stream":
                out.update(name=content.get("name", "stdout"), text=content.get("text", ""))
            elif kind == "error":
                out.update(ename=content.get("ename", ""), evalue=content.get("evalue", ""), traceback=content.get("traceback", []))
            else:
                out.update(data=content.get("data", {}), metadata=content.get("metadata", {}))
                if kind == "execute_result":
                    out["execution_count"] = content.get("execution_count")
            display_id = (content.get("transient") or {}).get("display_id")
            emit(ev="output", id=self._owner(msg), output=out, display_id=display_id)
        elif kind == "update_display_data":
            emit(ev="update", display_id=(content.get("transient") or {}).get("display_id"),
                 data=content.get("data", {}), metadata=content.get("metadata", {}))
        elif kind == "clear_output":
            emit(ev="clear", id=self._owner(msg), wait=bool(content.get("wait")))

    def on_shell(self, msg):
        parent = msg.get("parent_header", {}).get("msg_id")
        entry = self.requests.pop(parent, None)
        if not entry:
            return
        kind, rid = entry
        content = msg["content"]
        if kind == "execute":
            emit(ev="done", id=rid, status=content.get("status"), n=content.get("execution_count"))
        else:
            emit(ev="reply", id=rid, content=content)

    def on_stdin(self, msg):
        if msg["header"]["msg_type"] == "input_request":
            content = msg["content"]
            emit(ev="stdin", id=self._owner(msg), prompt=content.get("prompt", ""), password=bool(content.get("password")))

    # ---------- main loop ----------
    def run(self):
        channels = None
        last_alive = 0.0
        while True:
            try:
                while True:
                    cmd = self.commands.get_nowait()
                    if cmd is None or not self.handle(cmd):
                        return
                    channels = None  # a restart replaces the client
            except queue.Empty:
                pass
            if channels is None:
                channels = {self.kc.iopub_channel.socket: (self.kc.iopub_channel, self.on_iopub),
                            self.kc.shell_channel.socket: (self.kc.shell_channel, self.on_shell),
                            self.kc.stdin_channel.socket: (self.kc.stdin_channel, self.on_stdin)}
            for sock, _ in self.poller.poll(30):
                ch, handler = channels.get(sock, (None, None))
                if not ch:
                    continue
                while ch.msg_ready():
                    try:
                        handler(ch.get_msg(timeout=0))
                    except queue.Empty:
                        break
            now = time.monotonic()
            if now - last_alive > 1:
                last_alive = now
                if not self.dead_reported and not self.km.is_alive():
                    self.dead_reported = True
                    for kind, rid in list(self.requests.values()):
                        if kind == "execute":
                            emit(ev="done", id=rid, status="dead", n=None)
                    self.requests.clear()
                    emit(ev="dead")


def read_stdin(commands):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except ValueError:
            emit(ev="log", text=f"bad request: {line[:200]}")
    commands.put(None)


def main():
    cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    bridge = Bridge(cwd, [p for p in sys.argv[2:] if p])
    threading.Thread(target=read_stdin, args=(bridge.commands,), daemon=True).start()
    try:
        bridge.start()
    except Exception as exc:  # noqa: BLE001  (reported to the IDE, which shows it on the notebook)
        emit(ev="fatal", kind="start", message=f"{type(exc).__name__}: {exc}")
        bridge.shutdown()
        return
    try:
        bridge.run()
    except Exception as exc:  # noqa: BLE001
        emit(ev="fatal", kind="bridge", message=f"{type(exc).__name__}: {exc}")
    finally:
        bridge.shutdown()


if __name__ == "__main__":
    main()
