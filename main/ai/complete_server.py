"""Code completion sidecar for PyIDE: fill-in-the-middle with Qwen2.5-Coder (GGUF) on llama.cpp.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "complete", "model": "<path to .gguf>", "repo": "project", "path": "pkg/mod.py",
   "prefix": "...", "suffix": "...", "context": [{"path": ..., "text": ...}], "maxTokens": 48,
   "stop": [], "indent": 4, "blankIndent": 5}
  -> {"id": 1, "text": "...", "ms": 210, "promptTokens": 812, "reusedTokens": 790, "tokens": 9}
  {"id": 2, "op": "cancel", "target": 1}  (no reply; the target answers {"id": 1, "cancelled": true})
Events without an id report the model state: {"event": "loading"}, {"event": "ready", "ms": 450}.

Requests run one at a time. Consecutive prompts share most of their tokens (only the text around the caret
changes while typing), so the KV cache of the previous prompt is reused up to the first differing token.
A stop string or the block rule only applies after the completion has some non-whitespace text, so a completion
that starts on the next line still gets that line. With "indent" set, generation stops at the end of the block being
written: a later line indented less than "indent", or after a blank line, less than "blankIndent".
"""
import collections
import ctypes
import ctypes.wintypes
import json
import os
import sys
import time

if os.name == "nt":
    import msvcrt

FIM_PREFIX, FIM_SUFFIX, FIM_MIDDLE = "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"
REPO_NAME, FILE_SEP = "<|repo_name|>", "<|file_sep|>"
# Any of these ends the middle: the model moving on to another file, section, or chat turn.
END_TOKENS = ["<|endoftext|>", FIM_PREFIX, FIM_SUFFIX, FIM_MIDDLE, "<|fim_pad|>", REPO_NAME, FILE_SEP, "<|im_start|>", "<|im_end|>"]
N_CTX = 4096
PREFILL_CHUNK = 64  # cancellation is checked between chunks

llm = None
loaded_path = None
end_ids = set()
cancelled = set()
requests = collections.deque()
pending_input = b""


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load(path):
    global llm, loaded_path, end_ids
    emit({"event": "loading"})
    t = time.perf_counter()
    from llama_cpp import Llama

    llm = None
    logical = os.cpu_count() or 4
    # Decoding is memory bound and gains nothing from SMT siblings; prompt evaluation is compute bound and does.
    llm = Llama(model_path=path, n_ctx=N_CTX, n_batch=512, n_threads=max(1, logical // 2), n_threads_batch=logical, verbose=False)
    end_ids = {llm.token_eos()}
    for t_text in END_TOKENS:
        ids = llm.tokenize(t_text.encode(), add_bos=False, special=True)
        if len(ids) == 1:
            end_ids.add(ids[0])
    loaded_path = path
    emit({"event": "ready", "ms": round((time.perf_counter() - t) * 1000)})


def build_prompt(req, prefix, context):
    parts = [f"{REPO_NAME}{req.get('repo') or 'project'}\n"]
    for c in context:
        parts.append(f"{FILE_SEP}{c['path']}\n{c['text'].rstrip()}\n\n")
    parts.append(f"{FILE_SEP}{req.get('path') or 'untitled'}\n{FIM_PREFIX}{prefix}{FIM_SUFFIX}{req.get('suffix', '')}{FIM_MIDDLE}")
    return "".join(parts)


def tokenize(req, budget):
    prefix, context = req.get("prefix", ""), list(req.get("context") or [])
    while True:
        toks = llm.tokenize(build_prompt(req, prefix, context).encode("utf-8"), add_bos=False, special=True)
        if len(toks) <= budget:
            return toks
        # The client bounds every part in characters; this only trims an unusually token-dense prompt.
        if context:
            context.pop()
        else:
            prefix = prefix[len(prefix) // 4:]


def leading_indent(line):
    return len(line) - len(line.lstrip(" \t"))


def finished(text, stops, indent, blank_indent):
    """Index where the completion ends, or None while it may continue. Mirrors cutBlock in complete-text.js."""
    start = len(text) - len(text.lstrip())
    if start == len(text):
        return None
    for s in stops:
        i = text.find(s, start)
        if i >= 0:
            return i
    if indent is None:
        return None
    offset = text.find("\n", start) + 1
    after_blank = False
    while offset > 0:
        nl = text.find("\n", offset)
        line = text[offset:] if nl < 0 else text[offset:nl]
        # A line's indentation is settled once it has any text, even while the line is still being written.
        if not line.strip():
            after_blank = after_blank or nl >= 0
        else:
            n = leading_indent(line)
            if n < indent or (after_blank and n < blank_indent):
                return offset - 1
            after_blank = False
        offset = nl + 1
    return None


def prefill(toks, rid):
    """Evaluates all but the last prompt token, reusing the cached prefix. False if cancelled."""
    cached = llm.input_ids[: llm.n_tokens]
    keep = 0
    for a, b in zip(cached, toks[:-1]):
        if a != b:
            break
        keep += 1
    llm.n_tokens = keep
    for i in range(keep, len(toks) - 1, PREFILL_CHUNK):
        if is_cancelled(rid):
            return False, keep
        llm.eval(toks[i: min(len(toks) - 1, i + PREFILL_CHUNK)])
    return True, keep


def complete(req):
    rid = req["id"]
    t = time.perf_counter()
    if req.get("model") != loaded_path:
        load(req["model"])
    max_tokens = int(req.get("maxTokens") or 48)
    toks = tokenize(req, N_CTX - max_tokens - 8)
    ok, reused = prefill(toks, rid)
    if not ok:
        return {"id": rid, "cancelled": True}
    out, text, end = [], "", None
    stops, indent, blank_indent = req.get("stop") or [], req.get("indent"), req.get("blankIndent")
    for tok in llm.generate(toks, top_k=1, top_p=1.0, min_p=0.0, temp=0.0, repeat_penalty=1.0):
        if tok in end_ids:
            break
        out.append(tok)
        text = llm.detokenize(out).decode("utf-8", errors="ignore")
        end = finished(text, stops, indent, blank_indent)
        if end is not None or len(out) >= max_tokens or is_cancelled(rid):
            break
    if rid in cancelled:
        return {"id": rid, "cancelled": True}
    if end is not None:
        text = text[:end]
    return {"id": rid, "text": text, "ms": round((time.perf_counter() - t) * 1000),
            "promptTokens": len(toks), "reusedTokens": reused, "tokens": len(out)}


# Input is polled from the one thread that also runs the model: on Windows, a thread blocked reading the stdin pipe
# makes other threads touching the standard handles wait, and loading llama.cpp does, so it would hang.
def pipe_bytes_available():
    if os.name != "nt":
        import select
        return 65536 if select.select([0], [], [], 0)[0] else 0
    avail = ctypes.wintypes.DWORD(0)
    ok = ctypes.windll.kernel32.PeekNamedPipe(ctypes.wintypes.HANDLE(msvcrt.get_osfhandle(0)), None, 0, None, ctypes.byref(avail), None)
    return avail.value if ok else 65536  # a broken pipe reads as end of input


def read_input(block):
    """Moves complete request lines from stdin into `requests` and `cancelled`. False at end of input."""
    global pending_input
    n = 65536 if block else pipe_bytes_available()
    if not n:
        return True
    data = os.read(0, n)
    if not data:
        return False
    pending_input += data
    *lines, pending_input = pending_input.split(b"\n")
    for line in lines:
        if not line.strip():
            continue
        req = json.loads(line.decode("utf-8"))
        if req.get("op") == "cancel":
            cancelled.add(req.get("target"))
        else:
            requests.append(req)
    return True


def is_cancelled(rid):
    read_input(block=False)
    return rid in cancelled


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    while True:
        while not requests:
            if not read_input(block=True):
                return
        req = requests.popleft()
        rid = req.get("id")
        try:
            if rid in cancelled:
                emit({"id": rid, "cancelled": True})
            elif req.get("op") == "load":
                if req.get("model") != loaded_path:
                    load(req["model"])
                emit({"id": rid, "ok": True})
            elif req.get("op") == "complete":
                emit(complete(req))
            else:
                emit({"id": rid, "ok": True})
        except Exception as exc:  # reported to the IDE, the server keeps running
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            cancelled.discard(rid)


if __name__ == "__main__":
    main()
