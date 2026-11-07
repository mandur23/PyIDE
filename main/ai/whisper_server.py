"""Speech recognition sidecar for Nano Studio Cut: Whisper (transformers) with word timestamps, on the CPU.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "transcribe", "model": "openai/whisper-small", "file": "<raw float32 LE, 16 kHz mono>",
   "offset": 0, "length": 480000, "language": "ko" | "en" | "auto", "terms": ["Nano Studio", ...]}
  -> {"id": 1, "words": [[t0, t1, "text", lead, p], ...], "end": 28.4, "language": "ko", "ms": 2100}
     (seconds from `offset`; lead = 1 for the first word of one of Whisper's segments; p = how sure Whisper was of
     the word, the lowest probability of its tokens; end = where the text stops, null without words)
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
# A window whose text repeats itself (zlib ratio of its tokens above 1.35, "김치김치김치...") or that Whisper is unsure
# of (average log-probability under -1) is decoded again at a higher temperature, as OpenAI's transcribe does, and
# one it is unsure of that is likely no speech (probability over 0.6) gives no words: song lyrics under a music intro
# came out as captions. The seed makes the samples, and so the transcript, the same on every run.
FALLBACK = {"temperature": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0), "compression_ratio_threshold": 1.35, "logprob_threshold": -1.0, "no_speech_threshold": 0.6}
# The person's word list goes to Whisper as the text before the window (prompt_ids), the terms joined by commas, as
# many as fit in PROMPT_TOKENS (Whisper's limit is 223); the first terms win.
PROMPT_TOKENS = 200
NOT_TEXT = chr(0xFFFD)  # what a token holding part of a character's bytes decodes to
np = None
torch = None
processor = None
model = None
loaded = None
decoded = {}  # id of a decode's output -> its temperature (this request's)
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
    # The scores of a decode at temperature T are the logits divided by T; the words' probabilities need T back. The
    # fallback asks _need_fallback about every decode it makes; the output it keeps is the one asked about last. One
    # window can take two passes (Whisper seeks on when its last segment is cut off), each with its own temperature, so
    # the temperature is kept per output: a greedy first pass read with the second pass's 0.2 gave every word p 0.001.
    need = getattr(model, "_need_fallback", None)
    if need is not None:
        def remember(seek_sequence, seek_outputs, index, logits_processor, generation_config, vocab_size, temperature, *rest):
            decoded[id(seek_outputs[index])] = temperature
            return need(seek_sequence, seek_outputs, index, logits_processor, generation_config, vocab_size, temperature, *rest)

        model._need_fallback = remember
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


def confidence(probs):
    """A word's tokens' probabilities -> how sure Whisper was of the word: the least sure token."""
    return round(min(probs), 3) if probs else None


def token_probs(scores, tokens, temperature):
    """The probability Whisper gave each chosen token, from the scores of its decode (the logits after its rules,
    divided by the temperature when it sampled)."""
    if not scores:
        return []
    scale = temperature if temperature and temperature > 0 else 1.0
    logits = torch.stack([s.float() for s in scores[: len(tokens)]]) * scale
    chosen = torch.as_tensor(tokens[: logits.shape[0]], dtype=torch.long)
    return torch.softmax(logits, dim=-1).gather(-1, chosen.unsqueeze(-1)).squeeze(-1).tolist()


def words_of(ids, stamps, probs):
    """Token ids, their end times and probabilities (one segment) -> [[t0, t1, text, lead, p]]: a word starts at a
    token that begins with a space; punctuation and the pieces of a split character stay with the word before. lead is
    1 for the first word of the segment, whose start Whisper often puts where the segment starts, before a pause. p
    leaves out punctuation tokens: Whisper is often unsure of a comma, which the words do not depend on."""
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
            ps = []
            for i in cur:
                piece = tok.decode([ids[i]]).strip()
                if probs[i] is not None and (NOT_TEXT in piece or any(ch.isalnum() for ch in piece)):
                    ps.append(probs[i])
            out.append([round(t0, 3), round(max(t0, t1), 3), text, 0 if out else 1, confidence(ps)])

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
            if joined[-1][4] is None:
                joined[-1][4] = w[4]
        else:
            joined.append(w)
    return joined


def segment_probs(segment):
    """The probabilities of one of Whisper's segments' tokens. Its decode's scores cover the generated tokens only,
    and the segment's idxs count the decoder's prompt too. None when the decode's temperature is not known."""
    result = segment.get("result") or {}
    scores = result.get("scores")
    sequence = result.get("sequences")
    if not scores or sequence is None or id(result) not in decoded:
        return []
    temperature = decoded[id(result)]
    start = len(sequence) - len(scores)
    a, b = segment["idxs"]
    return token_probs(list(scores[max(0, a - start): max(0, b - start)]), segment["tokens"].tolist(), temperature)


def prompt_ids(terms):
    """The word list as Whisper's previous text: "term, term, ..." with as many terms as fit in PROMPT_TOKENS."""
    tok = processor.tokenizer
    kept = []
    for term in terms:
        term = " ".join(str(term).split())
        if not term:
            continue
        if len(tok(" " + ", ".join(kept + [term]), add_special_tokens=False)["input_ids"]) > PROMPT_TOKENS:
            break
        kept.append(term)
    return processor.get_prompt_ids(", ".join(kept), return_tensors="pt") if kept else None


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

    kwargs.update(FALLBACK)
    prompt = prompt_ids(req.get("terms") or [])
    if prompt is not None:
        kwargs["prompt_ids"] = prompt
    decoded.clear()
    torch.manual_seed(0)
    with torch.inference_mode():
        out = model.generate(feats.input_features, attention_mask=feats.attention_mask, stopping_criteria=StoppingCriteriaList([Cancel(rid)]), **kwargs)
    if rid in cancelled:
        return {"id": rid, "cancelled": True}
    # Segment by segment: the joined sequence restarts the times of a segment Whisper began anew at the window's end,
    # while each segment's own token times are from the window's start.
    seconds = audio.size / RATE
    segments = [s for s in (out.get("segments") or [[]])[0] if "token_timestamps" in s]
    pieces = [(s["tokens"].tolist(), s["token_timestamps"].tolist(), segment_probs(s), float(s["start"]), float(s["end"])) for s in segments]
    if not pieces:
        ids = out["sequences"][0].tolist()
        scores = [s[0] if s.dim() == 2 else s for s in (out.get("scores") or [])]
        lead = max(0, len(ids) - len(scores))
        temps = set(decoded.values())
        probs = [None] * lead + token_probs(scores, ids[lead:], temps.pop()) if len(temps) == 1 else []
        pieces = [(ids, out["token_timestamps"][0].tolist(), probs, 0.0, seconds)]
    words = []
    end = 0.0
    for ids, stamps, probs, s0, s1 in pieces:
        probs = (probs + [None] * len(ids))[: len(ids)]
        # The stamps belong to the last tokens when the two lists differ in length (a prompt left out of one of them).
        if len(stamps) != len(ids):
            n = min(len(stamps), len(ids))
            ids, stamps, probs = ids[-n:], stamps[-n:], probs[-n:]
        # A word stays inside its segment: under music the token times of "Good evening." (0-2 s) ran to 29 s.
        s0, s1 = max(0.0, min(s0, seconds)), max(0.0, min(max(s0, s1), seconds))
        clamp = lambda x: round(min(max(x, s0), s1), 3)  # noqa: E731
        found = words_of(ids, stamps, probs)
        words += [[clamp(a), clamp(b), w, lead, p] for a, b, w, lead, p in found]
        if found:
            end = max(end, s1)
    # end: where Whisper's text stops. Under music it can stop after one sentence with 28 s of speech left; the editor
    # then starts the next window there (speech.nextWindow).
    return {"id": rid, "words": words, "end": round(end, 3) if words else None, "language": heard, "ms": round((time.perf_counter() - t) * 1000)}


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
