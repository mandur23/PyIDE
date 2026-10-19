"""Regenerates the binary fixtures for verify/viewers.mjs. Run: py -3 verify/fixtures/viewers/make_fixtures.py

Works with the standard library alone; numpy, torch and imageio-ffmpeg are used when available.
"""
import json
import math
import os
import shutil
import struct
import subprocess
import wave
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def out(*parts):
    p = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def png(path, w, h, pixel):
    """RGBA PNG written by hand (zlib + CRC chunks)."""
    raw = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def make_png():
    # 64x48: a color gradient whose right third fades to transparent (shows the checkerboard).
    def px(x, y):
        a = 255 if x < 40 else max(0, 255 - (x - 40) * 11)
        return (x * 4 % 256, y * 5 % 256, 160, a)
    png(out("images", "sample.png"), 64, 48, px)


def make_wav():
    rate, secs = 22050, 1.0
    n = int(rate * secs)
    with wave.open(out("audio", "tone.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(n):
            env = math.sin(math.pi * i / n)
            left = int(12000 * env * math.sin(2 * math.pi * 440 * i / rate))
            right = int(8000 * env * math.sin(2 * math.pi * 660 * i / rate))
            frames += struct.pack("<hh", left, right)
        w.writeframes(bytes(frames))


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def make_video():
    exe = ffmpeg_exe()
    if not exe:
        print("video: no ffmpeg found, skipping clip.mp4 / voice.webm")
        return
    run = lambda args: subprocess.run([exe, "-y", "-loglevel", "error", *args], check=False).returncode == 0
    ok = run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
              "-movflags", "+faststart", out("video", "clip.mp4")])
    if not ok:
        ok = run(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=2", "-c:v", "libvpx-vp9", out("video", "clip.webm")])
    print("video:", "ok" if ok else "failed")
    ok = run(["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "libopus", out("video", "voice.webm")])
    print("audio-only webm:", "ok" if ok else "failed")


def npy_bytes(dtype_descr, shape, data):
    """.npy v1.0 by hand, per the NumPy format spec."""
    header = "{'descr': '%s', 'fortran_order': False, 'shape': (%s), }" % (
        dtype_descr, "".join("%d, " % s for s in shape) if len(shape) != 1 else "%d," % shape[0])
    pad = 64 - (10 + len(header) + 1) % 64
    header = header + " " * pad + "\n"
    return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header.encode("latin1") + data


def make_arrays():
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        np.save(out("arrays", "single.npy"), np.arange(12, dtype=np.float32).reshape(3, 4) / 2)
        rng = np.random.default_rng(0)
        np.savez(out("arrays", "cache.npz"),
                 features=rng.normal(size=(10, 8)).astype(np.float32),
                 labels=np.arange(10, dtype=np.int64),
                 mask=np.array([True, False] * 5),
                 cube=np.arange(24, dtype=np.int16).reshape(2, 3, 4))
        print("arrays: numpy", np.__version__)
    else:
        vals = [i / 2 for i in range(12)]
        with open(out("arrays", "single.npy"), "wb") as f:
            f.write(npy_bytes("<f4", (3, 4), struct.pack("<12f", *vals)))
        import zipfile
        with zipfile.ZipFile(out("arrays", "cache.npz"), "w") as z:
            z.writestr("features.npy", npy_bytes("<f4", (10, 8), struct.pack("<80f", *[math.sin(i) for i in range(80)])))
            z.writestr("labels.npy", npy_bytes("<i8", (10,), struct.pack("<10q", *range(10))))
            z.writestr("mask.npy", npy_bytes("|b1", (10,), bytes([1, 0] * 5)))
            z.writestr("cube.npy", npy_bytes("<i2", (2, 3, 4), struct.pack("<24h", *range(24))))
        print("arrays: written by hand (numpy missing)")


def make_models():
    # safetensors: 8-byte little-endian header length, JSON header, then the raw tensor data.
    tensors = [("encoder.weight", "F32", [4, 3]), ("encoder.bias", "F32", [4]), ("head.weight", "F16", [2, 4]),
               ("step", "I64", [])]
    size = {"F32": 4, "F16": 2, "I64": 8}
    header, offset = {"__metadata__": {"format": "pt", "note": "PyIDE fixture"}}, 0
    for name, dt, shape in tensors:
        n = size[dt] * math.prod(shape) if shape else size[dt]
        header[name] = {"dtype": dt, "shape": shape, "data_offsets": [offset, offset + n]}
        offset += n
    hb = json.dumps(header).encode()
    hb += b" " * ((8 - len(hb) % 8) % 8)
    with open(out("models", "tiny.safetensors"), "wb") as f:
        f.write(struct.pack("<Q", len(hb)) + hb + bytes(offset))

    try:
        import torch
        sd = {"conv.weight": torch.zeros(8, 3, 3, 3), "conv.bias": torch.zeros(8), "fc.weight": torch.zeros(10, 8)}
        torch.save({"state_dict": sd, "epoch": 3}, out("models", "tiny.pt"))
        print("models: torch", torch.__version__)
    except Exception as e:
        print("models: torch unavailable, skipping tiny.pt:", e)
    # Not a real ONNX graph: the viewer must still show size/date and a clear message.
    with open(out("models", "fake.onnx"), "wb") as f:
        f.write(b"\x08\x07\x12\x07pyide-fixture")


if __name__ == "__main__":
    make_png()
    make_wav()
    make_video()
    make_arrays()
    make_models()
    print("done")
