"""EmbeddingGemma 2 sidecar for PyIDE's semantic code search.

Reads one JSON request per line on stdin and answers with one JSON line on stdout:
  {"id": 1, "op": "embed", "kind": "query" | "document", "items": [{"text": ..., "title": ...}], "dim": 256}
  -> {"id": 1, "n": 2, "dim": 256, "data": "<base64 float32, row-major>"}
Events without an id report the model state: {"event": "loading"}, {"event": "ready", "device": "cpu"}.
Prompts follow the model card's CodeRetrieval task (text only; the vision and audio encoders are not loaded).
"""
import base64
import json
import os
import sys

MODEL_ID = "google/embeddinggemma-2"
model = None


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def be_gentle(torch):
    """Indexing runs beside the user's work: half the cores torch would take (PYIDE_SEMANTIC_THREADS overrides),
    and below-normal priority on Windows, so the editor and the user's own programs come first."""
    threads = int(os.environ.get("PYIDE_SEMANTIC_THREADS") or 0) or max(1, torch.get_num_threads() // 2)
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:  # only settable before torch's first parallel work
        pass
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    return threads


def load():
    global model
    import torch
    from sentence_transformers import SentenceTransformer

    threads = be_gentle(torch)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # float16 degrades this model (model card); bfloat16 on GPU, float32 on CPU.
    model_kwargs = {"torch_dtype": torch.bfloat16} if device == "cuda" else {}
    model = SentenceTransformer(
        MODEL_ID,
        device=device,
        config_kwargs={"vision_config": None, "audio_config": None},
        model_kwargs=model_kwargs,
    )
    emit({"event": "ready", "device": device, "threads": threads})


def prompt(item, kind):
    text = item.get("text", "")
    if kind == "query":
        return f"task: code retrieval | query: {text}"
    return f"title: {item.get('title') or 'none'} | text: {text}"


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            if model is None:
                emit({"event": "loading"})
                load()
            if req.get("op") == "ping":
                emit({"id": rid, "ok": True})
                continue
            dim = int(req.get("dim") or 256)
            texts = [prompt(it, req.get("kind")) for it in req.get("items", [])]
            vecs = model.encode(texts, batch_size=16, normalize_embeddings=True, truncate_dim=dim, convert_to_numpy=True)
            data = base64.b64encode(vecs.astype("float32").tobytes()).decode("ascii")
            emit({"id": rid, "n": len(texts), "dim": dim, "data": data})
        except Exception as exc:  # reported to the IDE, the server keeps running
            emit({"id": rid, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
