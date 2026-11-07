"""Voice isolation sidecar for Nano Studio Cut: the vocals stem of HTDemucs (Meta's Hybrid Transformer Demucs), on the CPU.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "separate", "weights": ["<...>/955717e8.safetensors"], "file": "<raw float32 LE, 44.1 kHz,
   interleaved>", "channels": 2, "frames": 441000, "out": "<...>.wav.part"}
  -> {"id": 1, "ok": true, "frames": 441000, "ms": 9100}   (out holds a 16-bit WAV of the vocals, `frames` long)
  {"id": 2, "op": "cancel", "target": 1}  (no reply; the target answers {"id": 1, "cancelled": true}, out deleted)
Events without an id: {"event": "loading"}, {"event": "ready", "ms": 900},
  {"event": "progress", "request": 1, "fraction": 0.25}.

The model is built here from the safetensors file's own metadata (klass, kwargs) with demucs.htdemucs.HTDemucs, and its
weights read with safetensors: demucs' pretrained loader and audio helpers want torchaudio, which this environment has
not got, and nothing here goes to the network. The sound is read and separated one model segment (7.8 s) at a time
with a quarter of overlap, cross-faded as demucs.apply does, and each finished part written out at once, so memory
stays the same for any length. A cancel is seen between segments.
"""
import collections
import ctypes
import ctypes.wintypes
import json
import os
import sys
import time
from fractions import Fraction

if os.name == "nt":
    import msvcrt

RATE = 44100
OVERLAP = 0.25
DC_REACH = RATE // 2  # half the window of the moving average the input's offset is taken out with
KLASS = "demucs.htdemucs.HTDemucs"
np = None
torch = None
models = []
loaded = None
cancelled = set()
requests = collections.deque()
pending_input = b""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build(path):
    """One HTDemucs from a safetensors file whose metadata names its class and keyword arguments."""
    from demucs.htdemucs import HTDemucs
    from safetensors import safe_open
    from safetensors.torch import load_file

    with safe_open(path, framework="pt") as f:
        meta = f.metadata() or {}
    if meta.get("klass") != KLASS:
        raise ValueError(f"{os.path.basename(path)} is not an HTDemucs model ({meta.get('klass')})")
    kwargs = json.loads(meta.get("kwargs") or "{}")
    for k, v in list(kwargs.items()):
        if isinstance(v, dict) and v.get("_type") == "fraction":
            kwargs[k] = Fraction(v["numerator"], v["denominator"])
    model = HTDemucs(*json.loads(meta.get("args") or "[]"), **kwargs)
    model.load_state_dict(load_file(path))
    return model.eval()


def load(weights):
    global np, torch, models, loaded
    emit({"event": "loading"})
    t = time.perf_counter()
    import numpy
    import torch as _torch

    np, torch = numpy, _torch
    models = [build(p) for p in weights]
    if any(m.samplerate != RATE or m.audio_channels != 2 or "vocals" not in m.sources for m in models):
        raise ValueError("the model is not a 44.1 kHz stereo model with a vocals stem")
    loaded = list(weights)
    emit({"event": "ready", "ms": round((time.perf_counter() - t) * 1000)})


def read_frames(f, start, count, channels):
    f.seek(start * channels * 4)
    data = f.read(count * channels * 4)
    x = np.frombuffer(data[: len(data) // (channels * 4) * channels * 4], dtype="<f4").reshape(-1, channels)
    return torch.from_numpy(x.T.copy())


def read_dc_free(f, start, count, channels, total):
    """Frames [start, start + count) less their 1 s moving average. HTDemucs adds each segment's mean back to every
    stem, so a DC offset that comes and goes with the speech (synthesized voices have one) filled the pauses of the
    vocals at -44 dBFS, and Whisper's word times could no longer find them. A 1 s average takes nothing audible."""
    lo = max(0, start - DC_REACH)
    hi = min(total, start + count + DC_REACH)
    x = read_frames(f, lo, hi - lo, channels).double()
    n = x.shape[1]
    sums = torch.nn.functional.pad(torch.cumsum(x, dim=1), (1, 0))
    at = torch.arange(start - lo, min(n, start - lo + count))
    a = (at - DC_REACH).clamp(min=0)
    b = (at + DC_REACH + 1).clamp(max=n)
    return (x[:, at] - (sums[:, b] - sums[:, a]) / (b - a)).float()


def vocals(chunk):
    """[2, n] (normalised) -> the vocals [2, n], averaged over the models of a bag."""
    out = 0
    with torch.inference_mode():
        for m in models:
            out = out + m(chunk[None])[0, m.sources.index("vocals")]
    return out / len(models)


def separate(req):
    import soundfile

    rid = req["id"]
    t = time.perf_counter()
    if req.get("weights") != loaded:
        load(req["weights"])
    channels = int(req.get("channels") or 2)
    if channels not in (1, 2):
        raise ValueError("the sound has one or two channels")
    total = os.path.getsize(req["file"]) // (channels * 4)
    frames = max(total, int(req.get("frames") or 0))
    out = req["out"]
    segment = int(models[0].segment * RATE)
    stride = int((1 - OVERLAP) * segment)
    # The cross-fade of demucs.apply: a triangle over the segment, so overlapping parts add up evenly.
    half = segment // 2
    weight = torch.cat([torch.arange(1, half + 1), torch.arange(segment - half, 0, -1)]).float()
    weight /= weight.max()
    # The scale of the whole sound, as demucs.separate normalises it (one pass of reading, no model); the offset goes
    # with read_dc_free instead of being added back.
    n, s1, s2 = 0, 0.0, 0.0
    with open(req["file"], "rb") as f:
        while True:
            x = np.frombuffer(f.read(RATE * 10 * channels * 4), dtype="<f4")
            if not x.size:
                break
            mono = x.reshape(-1, channels).astype(np.float64).mean(axis=1)
            n, s1, s2 = n + mono.size, s1 + mono.sum(), s2 + (mono ** 2).sum()
    mean = s1 / n if n else 0.0
    std = max(1e-8, ((s2 / n - mean * mean) * n / max(1, n - 1)) ** 0.5) if n else 1.0
    acc = torch.zeros(2, segment)
    wsum = torch.zeros(segment)
    done = 0
    stopped = False
    with open(req["file"], "rb") as f, soundfile.SoundFile(out, "w", samplerate=RATE, channels=channels, subtype="PCM_16", format="WAV") as w:
        for offset in range(0, max(total, 1), stride):
            if is_cancelled(rid):
                stopped = True
                break
            x = read_dc_free(f, offset, segment, channels, total)
            if x.shape[1] == 0:
                break
            if channels == 1:
                x = x.expand(2, -1)
            y = vocals(x / std) * std
            k = y.shape[1]
            acc[:, :k] += y * weight[:k]
            wsum[:k] += weight[:k]
            last = offset + segment >= total
            keep = min(total - offset, segment) if last else stride
            part = (acc[:, :keep] / wsum[:keep].clamp_min(1e-8)).T
            part = (part.mean(dim=1, keepdim=True) if channels == 1 else part).clamp(-1, 1).numpy()
            w.write(part)
            done += keep
            acc = torch.cat([acc[:, keep:], torch.zeros(2, keep)], dim=1)
            wsum = torch.cat([wsum[keep:], torch.zeros(keep)])
            emit({"event": "progress", "request": rid, "fraction": round(min(1.0, done / max(1, total)), 4)})
            if last:
                break
        if not stopped and frames > done:
            # The media can be longer than its sound (a video track that ends later): silence to the end, so a clip of
            # the media fits the new file too.
            for at in range(done, frames, RATE * 10):
                w.write(np.zeros((min(RATE * 10, frames - at), channels), dtype=np.float32))
    if stopped:
        try:
            os.remove(out)
        except OSError:
            pass
        return {"id": rid, "cancelled": True}
    return {"id": rid, "ok": True, "frames": frames, "ms": round((time.perf_counter() - t) * 1000)}


# Input is polled from the one thread that also runs the model, as in whisper_server.py: on Windows a thread blocked
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
                if req.get("weights") != loaded:
                    load(req["weights"])
                emit({"id": rid, "ok": True})
            elif req.get("op") == "separate":
                emit(separate(req))
            else:
                emit({"id": rid, "ok": True})
        except Exception as exc:  # reported to the editor, the server keeps running
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            cancelled.discard(rid)


if __name__ == "__main__":
    main()
