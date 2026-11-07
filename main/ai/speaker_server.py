"""Speaker embedding sidecar for Nano Studio Cut: WeSpeaker ResNet34-LM (ONNX, onnxruntime) on the CPU.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "embed", "model": "<path of voxceleb_resnet34_LM.onnx>", "file": "<raw float32 LE, 16 kHz mono>",
   "windows": [[offset, length], ...]}   (samples)
  -> {"id": 1, "dim": 256, "embeddings": "<base64 of float32 LE, one row of dim values per window>", "ms": 900}
  {"id": 2, "op": "cancel", "target": 1}  (no reply; the target answers {"id": 1, "cancelled": true})
Events without an id report the model state: {"event": "loading"}, {"event": "ready", "ms": 300}.

The features are what WeSpeaker trained the model on (its config.yaml): Kaldi fbank, 80 mel bins, 25 ms frames every
10 ms, a Hamming window, no dither, the samples scaled to 16-bit, and the mean of each window's frames taken away.
torchaudio is not in the shared AI environment, so the fbank is computed here with numpy, step for step as
torchaudio.compliance.kaldi.fbank does it. The model is a local file (it was downloaded when the person asked); nothing
here goes to the network. A cancel is seen between batches.
"""
import base64
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
FRAME = 400  # 25 ms
SHIFT = 160  # 10 ms
NFFT = 512
MELS = 80
BATCH = 32
MAX_WINDOW = 30 * RATE
np = None
session = None
loaded = None
mel_bank = None
window_fn = None
cancelled = set()
requests = collections.deque()
pending_input = b""


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def mel(f):
    return 1127.0 * np.log(1.0 + f / 700.0)


def mel_banks():
    """torchaudio's get_mel_banks(80, 512, 16000, low_freq=20, high_freq=0): triangles in the mel domain over the FFT
    bins below Nyquist, plus a zero column for the Nyquist bin."""
    low, high = mel(20.0), mel(RATE / 2.0)
    delta = (high - low) / (MELS + 1)
    left = low + np.arange(MELS)[:, None] * delta
    center, right = left + delta, left + 2 * delta
    m = mel(np.arange(NFFT // 2) * (RATE / NFFT))[None, :]
    up = (m - left) / (center - left)
    down = (right - m) / (right - center)
    banks = np.maximum(0.0, np.minimum(up, down))
    return np.pad(banks, ((0, 0), (0, 1))).astype(np.float64)


def fbank(x):
    """Kaldi fbank of float samples in [-1, 1) -> (frames, 80) float32, mean-normalized over the frames."""
    x = x.astype(np.float64) * 32768.0
    n = 1 + (x.size - FRAME) // SHIFT
    if n < 1:
        return np.zeros((0, MELS), np.float32)
    frames = np.lib.stride_tricks.as_strided(x, shape=(n, FRAME), strides=(x.strides[0] * SHIFT, x.strides[0])).copy()
    frames -= frames.mean(axis=1, keepdims=True)
    frames[:, 1:] -= 0.97 * frames[:, :-1].copy()
    frames[:, 0] -= 0.97 * frames[:, 0]
    frames *= window_fn
    power = np.abs(np.fft.rfft(frames, n=NFFT, axis=1)) ** 2
    feats = np.log(np.maximum(power @ mel_bank.T, np.finfo(np.float32).eps))
    feats -= feats.mean(axis=0, keepdims=True)
    return feats.astype(np.float32)


def load(path):
    global np, session, loaded, mel_bank, window_fn
    emit({"event": "loading"})
    t = time.perf_counter()
    import numpy
    import onnxruntime

    np = numpy
    opts = onnxruntime.SessionOptions()
    opts.log_severity_level = 3
    session = onnxruntime.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
    mel_bank = mel_banks()
    window_fn = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(FRAME) / (FRAME - 1))
    loaded = path
    emit({"event": "ready", "ms": round((time.perf_counter() - t) * 1000)})


def read_samples(path, offset, length):
    length = max(0, min(int(length), MAX_WINDOW))
    with open(path, "rb") as f:
        f.seek(int(offset) * 4)
        data = f.read(length * 4)
    return np.frombuffer(data[: len(data) // 4 * 4], dtype="<f4")


def embed(req):
    rid = req.get("id")
    if req.get("model") != loaded:
        load(req["model"])
    t = time.perf_counter()
    windows = req.get("windows") or []
    feats = [fbank(read_samples(req["file"], a, n)) for a, n in windows]
    dim = session.get_outputs()[0].shape[1]
    out = np.zeros((len(feats), dim), np.float32)
    # Windows of one length go through the model together.
    by_len = collections.defaultdict(list)
    for i, f in enumerate(feats):
        if f.shape[0] >= 10:
            by_len[f.shape[0]].append(i)
    name = session.get_inputs()[0].name
    for _length, idx in sorted(by_len.items()):
        for k in range(0, len(idx), BATCH):
            if is_cancelled(rid):
                return {"id": rid, "cancelled": True}
            part = idx[k: k + BATCH]
            out[part] = session.run(None, {name: np.stack([feats[i] for i in part])})[0]
    return {"id": rid, "dim": int(dim), "embeddings": base64.b64encode(out.astype("<f4").tobytes()).decode("ascii"), "ms": round((time.perf_counter() - t) * 1000)}


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
            elif req.get("op") == "embed":
                emit(embed(req))
            else:
                emit({"id": rid, "ok": True})
        except Exception as exc:  # reported to the editor, the server keeps running
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            cancelled.discard(rid)


if __name__ == "__main__":
    main()
