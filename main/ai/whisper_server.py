"""Speech recognition sidecar for Nano Studio Cut: Whisper (transformers) with word timestamps, on the CPU.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "transcribe", "model": "openai/whisper-small", "file": "<raw float32 LE, 16 kHz mono>",
   "offset": 0, "length": 480000, "language": "ko" | "en" | "auto"}
  -> {"id": 1, "words": [[t0, t1, "text", lead], ...], "language": "ko", "ms": 2100}
     (seconds from `offset`; lead = 1 for the first word of one of Whisper's segments)
  {"id": 2, "op": "cancel", "target": 1}  (no reply; the target answers {"id": 1, "cancelled": true})
Events without an id report the model state: {"event": "loading"}, {"event": "ready", "ms": 2400}.

One window of at most 30 s per request (the editor splits long audio and joins the windows). The model is read from
the Hugging Face cache only (local_files_only): it was downloaded when the person asked for it, and nothing here goes
to the network. A window without any sound above -50 dBFS gives no words: Whisper writes text into silence.
Requests run one at a time; a cancel is seen between generated tokens.
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

RATE = 16000
MAX_SECONDS = 30
SILENT_DB = -50.0
LANGUAGES = ("ko", "en")

np = None
torch = None
processor = None
model = None
loaded = None
cancelled = set()
requests = collections.deque()
pending_input = b""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load(repo):
    global np, torch, processor, model, loaded
    emit({"event": "loading", "model": repo})
    t = time.perf_counter()
    import numpy
    import torch as _torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    np, torch = numpy, _torch
    model = None
    processor = WhisperProcessor.from_pretrained(repo, local_files_only=True)
    # Eager attention: word timestamps come from the cross-attention weights, which the fused kernels do not return.
    model = WhisperForConditionalGeneration.from_pretrained(repo, local_files_only=True, dtype=torch.float32, attn_implementation="eager").eval()
    loaded = repo
    emit({"event": "ready", "ms": round((time.perf_counter() - t) * 1000)})


def read_window(path, offset, length):
    length = max(0, min(int(length), RATE * MAX_SECONDS))
    with open(path, "rb") as f:
        f.seek(int(offset) * 4)
        data = f.read(length * 4)
    return np.frombuffer(data[: len(data) // 4 * 4], dtype="<f4").astype(np.float32)


def loudest_db(audio):
    hop = RATE // 100 * 3
    if audio.size < hop:
        return -200.0
    frames = audio[: audio.size // hop * hop].reshape(-1, hop)
    ms = float((frames.astype(np.float64) ** 2).mean(axis=1).max())
    return 10 * np.log10(ms) if ms > 0 else -200.0


class Cancel:
    """A stopping criterion that ends generation once a cancel for this request has arrived."""

    def __init__(self, rid):
        self.rid = rid

    def __call__(self, input_ids, scores, **kwargs):
        stop = is_cancelled(self.rid)
        return torch.full((input_ids.shape[0],), stop, dtype=torch.bool)


def words_of(ids, stamps):
    """Token ids and their end times (one segment) -> [[t0, t1, text, lead]]: a word starts at a token that begins
    with a space; punctuation and the pieces of a split character stay with the word before. lead is 1 for the first
    word of the segment, whose start Whisper often puts where the segment starts, before a pause."""
    tok = processor.tokenizer
    special = set(tok.all_special_ids)
    first_stamp = tok.convert_tokens_to_ids("<|0.00|>")
    out, cur = [], []

    def close():
        if not cur:
            return
        text = tok.decode([ids[i] for i in cur]).strip()
        if text:
            # A token's stamp is the time it ends: a word starts where the token before it ends.
            t0 = float(stamps[cur[0] - 1]) if cur[0] > 0 else 0.0
            t1 = float(stamps[cur[-1]])
            out.append([round(t0, 3), round(max(t0, t1), 3), text, 0 if out else 1])

    for i, t in enumerate(ids):
        if t in special or (first_stamp is not None and t >= first_stamp):
            close()
            cur = []
            continue
        piece = tok.convert_ids_to_tokens(int(t))
        if piece.startswith("Ġ") and cur:
            close()
            cur = []
        cur.append(i)
    close()
    # A word made only of punctuation joins the one before it.
    joined = []
    for w in out:
        if joined and not any(ch.isalnum() for ch in w[2]):
            joined[-1][2] += w[2]
            joined[-1][1] = max(joined[-1][1], w[1])
        else:
            joined.append(w)
    return joined


def detect_language(features):
    """The language code Whisper hears in a window ("ko"), from one pass of the encoder."""
    ids = model.detect_language(features)
    piece = processor.tokenizer.convert_ids_to_tokens(int(ids.reshape(-1)[0])) or ""
    return piece[2:-2] if piece.startswith("<|") and piece.endswith("|>") else None


def transcribe(req):
    rid = req["id"]
    t = time.perf_counter()
    if req.get("model") != loaded:
        load(req["model"])
    audio = read_window(req["file"], req.get("offset", 0), req.get("length", 0))
    if audio.size < RATE // 10 or loudest_db(audio) < SILENT_DB:
        return {"id": rid, "words": [], "language": None, "ms": round((time.perf_counter() - t) * 1000)}
    feats = processor(audio, sampling_rate=RATE, return_tensors="pt", return_attention_mask=True)
    kwargs = {"task": "transcribe", "return_timestamps": True, "return_token_timestamps": True, "return_dict_in_generate": True}
    lang = req.get("language") or "auto"
    heard = lang if lang in LANGUAGES else detect_language(feats.input_features)
    if heard:
        kwargs["language"] = heard
    from transformers import StoppingCriteriaList

    with torch.inference_mode():
        out = model.generate(feats.input_features, attention_mask=feats.attention_mask, stopping_criteria=StoppingCriteriaList([Cancel(rid)]), **kwargs)
    if rid in cancelled:
        return {"id": rid, "cancelled": True}
    # Segment by segment: the joined sequence restarts the times of a segment Whisper began anew at the window's end,
    # while each segment's own token times are from the window's start.
    pieces = [(s["tokens"].tolist(), s["token_timestamps"].tolist()) for s in (out.get("segments") or [[]])[0] if "token_timestamps" in s]
    if not pieces:
        pieces = [(out["sequences"][0].tolist(), out["token_timestamps"][0].tolist())]
    seconds = audio.size / RATE
    words = []
    for ids, stamps in pieces:
        # The stamps belong to the last tokens when the two lists differ in length (a prompt left out of one of them).
        if len(stamps) != len(ids):
            n = min(len(stamps), len(ids))
            ids, stamps = ids[-n:], stamps[-n:]
        words += [[min(a, seconds), min(b, seconds), w, lead] for a, b, w, lead in words_of(ids, stamps)]
    return {"id": rid, "words": words, "language": heard, "ms": round((time.perf_counter() - t) * 1000)}


# Input is polled from the one thread that also runs the model, as in complete_server.py: on Windows a thread blocked
# reading the stdin pipe makes other threads that touch the standard handles wait.
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
                if req.get("model") != loaded:
                    load(req["model"])
                emit({"id": rid, "ok": True})
            elif req.get("op") == "transcribe":
                emit(transcribe(req))
            else:
                emit({"id": rid, "ok": True})
        except Exception as exc:  # reported to the editor, the server keeps running
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            cancelled.discard(rid)


if __name__ == "__main__":
    main()
