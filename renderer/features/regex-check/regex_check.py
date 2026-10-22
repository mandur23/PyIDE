"""Check RegExp helper: evaluates a Python regular expression against a sample text with the interpreter's own `re`.

Reads JSON lines on stdin, answers one JSON line per request on stdout:
  request  {"id", "literal": Python string literal source (r'...', b"...", '''...'''), "flags": ["I", "M", ...],
            "mode": "search" | "match" | "fullmatch", "text": sample, "limit": max matches}
  answer   {"id", "ok": true, "pattern": decoded pattern (str; bytes as latin-1), "bytes": bool, "groups": n,
            "names": {name: index}, "matches": [{"span": [start, end], "groups": [[start, end] | null, ...]}],
            "truncated": bool}
         | {"id", "ok": false, "error": {"kind": "syntax" | "literal" | "internal", "msg", "pos", "lineno", "colno"}}
Positions are UTF-16 code units (JavaScript string indexes): spans into the sample, `pos` into the decoded pattern.
Run with -I so nothing from the project shadows `re`.
"""
import ast
import warnings
import json
import re
import sys

FLAGS = {
    "I": re.IGNORECASE, "IGNORECASE": re.IGNORECASE, "M": re.MULTILINE, "MULTILINE": re.MULTILINE,
    "S": re.DOTALL, "DOTALL": re.DOTALL, "X": re.VERBOSE, "VERBOSE": re.VERBOSE, "A": re.ASCII, "ASCII": re.ASCII,
    "U": re.UNICODE, "UNICODE": re.UNICODE, "L": getattr(re, "LOCALE", 0), "LOCALE": getattr(re, "LOCALE", 0),
}


def utf16_index(text):
    """Code point index -> UTF-16 index, computed once per text."""
    if all(ord(c) < 0x10000 for c in text):
        return lambda i: i
    table = [0]
    for c in text:
        table.append(table[-1] + (2 if ord(c) >= 0x10000 else 1))
    return lambda i: table[i]


def evaluate(req):
    try:
        pattern = ast.literal_eval(req["literal"])
    except Exception as err:  # an f-string or a literal that does not parse
        return {"ok": False, "error": {"kind": "literal", "msg": str(err)}}
    if not isinstance(pattern, (str, bytes)):
        return {"ok": False, "error": {"kind": "literal", "msg": "not a string literal"}}
    is_bytes = isinstance(pattern, bytes)
    shown = pattern.decode("latin-1") if is_bytes else pattern
    flags = 0
    for name in req.get("flags") or []:
        flags |= FLAGS.get(name, 0)
    if is_bytes:
        flags &= ~re.UNICODE
    try:
        rx = re.compile(pattern, flags)
    except re.error as err:
        pos = err.pos if err.pos is not None else None
        return {"ok": False, "pattern": shown, "bytes": is_bytes, "error": {
            "kind": "syntax", "msg": err.msg, "pos": utf16_index(shown)(pos) if pos is not None else None,
            "lineno": err.lineno, "colno": err.colno}}
    except (ValueError, TypeError, OverflowError, RecursionError) as err:
        return {"ok": False, "pattern": shown, "bytes": is_bytes, "error": {"kind": "syntax", "msg": str(err), "pos": None}}

    text = req.get("text") or ""
    subject = text.encode("utf-8") if is_bytes else text
    if is_bytes:
        # Byte offsets -> UTF-16 offsets in the sample text.
        table = [0] * (len(subject) + 1)
        at = 0
        units = 0
        for c in text:
            b = len(c.encode("utf-8"))
            for k in range(b):
                table[at + k] = units
            at += b
            units += 2 if ord(c) >= 0x10000 else 1
        table[at] = units
        conv = lambda i: table[i]
    else:
        conv = utf16_index(text)

    limit = int(req.get("limit") or 1000)
    mode = req.get("mode") or "search"
    if mode == "match":
        found = [m for m in [rx.match(subject)] if m]
    elif mode == "fullmatch":
        found = [m for m in [rx.fullmatch(subject)] if m]
    else:
        found = []
        for m in rx.finditer(subject):
            found.append(m)
            if len(found) > limit:
                break
    truncated = len(found) > limit
    matches = []
    for m in found[:limit]:
        groups = []
        for g in range(1, rx.groups + 1):
            s, e = m.span(g)
            groups.append(None if s < 0 else [conv(s), conv(e)])
        matches.append({"span": [conv(m.start()), conv(m.end())], "groups": groups})
    return {"ok": True, "pattern": shown, "bytes": is_bytes, "groups": rx.groups, "names": dict(rx.groupindex),
            "matches": matches, "truncated": truncated}


def main():
    warnings.simplefilter("ignore")  # an invalid escape in a non-raw literal is the user's code, not an error here
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            answer = evaluate(req)
        except Exception as err:  # keep serving: one odd request must not end the helper
            answer = {"ok": False, "error": {"kind": "internal", "msg": "%s: %s" % (type(err).__name__, err)}}
        answer["id"] = req.get("id")
        out.write(json.dumps(answer, ensure_ascii=True) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
