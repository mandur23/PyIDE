"""PyIDE Data View helper: pages tables out of the user's process.

The IDE evaluates `pyide_sciview.call(<object expression>, '<base64 JSON request>')` wherever the object lives (the
debugger's suspended frame, the Python Console, a notebook kernel) and gets back base64 JSON, so the value survives
any repr() on the way. Nothing here loads a whole table into the IDE: every request returns one block of rows and
columns. Sorted and filtered row orders are cached per object, keyed by the IDE's refresh generation.

Supported: pandas DataFrame and Series, NumPy arrays (1-D, 2-D, structured, and 2-D slices of higher dimensions),
polars DataFrame and Series, and lists or tuples of dicts. Only modules the user already imported are touched.
"""
import base64
import builtins
import csv
import json
import math
import reprlib
import sys
import types
from collections import OrderedDict
from itertools import islice

MAX_TEXT = 1000
HIDDEN_NAMES = {"In", "Out", "exit", "quit", "get_ipython"}
_cache = OrderedDict()
_CACHE_SIZE = 4

_short = reprlib.Repr()
_short.maxstring = 80
_short.maxother = 80
_short.maxlist = _short.maxtuple = _short.maxdict = _short.maxset = 8


def call(obj, request):
    """Entry point. `request` is base64 JSON; the answer is base64 JSON with either results or {"error": text}."""
    try:
        req = json.loads(base64.b64decode(request).decode("utf-8"))
        result = _dispatch(obj, req)
    except Exception as exc:  # noqa: BLE001  (every failure goes back to the IDE as text)
        result = {"error": _error_text(exc)}
    try:
        text = json.dumps(result, ensure_ascii=False, default=str, allow_nan=False)
    except ValueError:
        text = json.dumps(_finite(result), ensure_ascii=False, default=str)
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _dispatch(obj, req):
    op = req.get("op")
    if op == "vars":
        return {"vars": variables(obj)}
    if op == "kind":
        return {"kind": kind(obj), "type": _type_name(obj), "shape": _shape(obj)}
    if kind(obj) is None:
        return {"error": "Cannot view a value of type %s as a table" % _type_name(obj), "unsupported": True}
    view = _view(obj, req)
    if op == "info":
        return view.info()
    if op == "page":
        return view.page(int(req.get("start", 0)), int(req.get("count", 100)), int(req.get("colStart", 0)),
                         int(req.get("colCount", 50)), bool(req.get("heat")))
    if op == "csv":
        return view.to_csv(req["path"], req.get("sep", ","))
    return {"error": "Unknown request %r" % (op,)}


def _error_text(exc):
    return "%s: %s" % (type(exc).__name__, exc) if str(exc) else type(exc).__name__


def _finite(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


# ---------- what can be viewed ----------
def _module_of(obj):
    return (type(obj).__module__ or "").split(".")[0]


def _np():
    return sys.modules.get("numpy")


def kind(obj):
    """'frame' for things shown as a DataFrame, 'array' for NumPy arrays, None otherwise."""
    mod = _module_of(obj)
    name = type(obj).__name__
    if mod == "pandas" and name in ("DataFrame", "Series"):
        return "frame"
    if mod == "polars" and name in ("DataFrame", "Series"):
        return "frame"
    np = _np()
    if np is not None and isinstance(obj, np.ndarray) and obj.ndim >= 1:
        return "array"
    if isinstance(obj, (list, tuple)) and obj and isinstance(obj[0], dict) and isinstance(obj[-1], dict) \
            and all(isinstance(x, dict) for x in islice(obj, 100)):
        return "frame"
    return None


def _type_name(obj):
    return type(obj).__name__


def _shape(obj):
    shape = getattr(obj, "shape", None)
    if isinstance(shape, tuple):
        return list(shape)
    try:
        return [len(obj)]
    except Exception:  # noqa: BLE001
        return None


def variables(ns):
    """Names in a namespace for the Variables views, with what the Data View can open."""
    out = []
    for name, value in list(ns.items()):
        if name.startswith("_") or name in HIDDEN_NAMES or isinstance(value, types.ModuleType):
            continue
        k = kind(value)
        shape = _shape(value) if k or hasattr(value, "shape") else None
        try:
            text = _summary(value, k)
        except Exception as exc:  # noqa: BLE001
            text = "<%s>" % _error_text(exc)
        out.append({"name": name, "type": _type_name(value), "kind": k, "shape": shape, "value": text})
        if len(out) >= 1000:
            break
    out.sort(key=lambda v: v["name"].lower())
    return out


def _summary(value, k):
    if k == "frame" and hasattr(value, "columns"):
        cols = [_label(c) for c in islice(value.columns, 8)]
        more = ", …" if len(value.columns) > 8 else ""
        return "[%s%s]" % (", ".join(cols), more)
    if k == "frame" and isinstance(value, (list, tuple)):
        return "[%s, …]" % _short.repr(value[0])
    if k == "array" and value.size > 100:
        return "%s array" % value.dtype
    text = " ".join(_short.repr(value).split())
    return text if len(text) <= 200 else text[:200] + "…"


# ---------- formatting ----------
def _float_text(v):
    if v in (math.inf, -math.inf):
        return "inf" if v > 0 else "-inf"
    r = repr(float(v))
    return r if len(r) <= 12 else "%.10g" % v


def _missing(v):
    """The text of a missing value (None, NaN, NaT, pd.NA), or None for a real one."""
    if v is None:
        return "None"
    if isinstance(v, float):
        return "NaN" if v != v else None
    tname = type(v).__name__
    if tname in ("NaTType", "NaT"):
        return "NaT"
    if tname == "NAType":
        return "<NA>"
    np = _np()
    if np is not None and isinstance(v, np.generic):
        if isinstance(v, np.floating) and v != v:
            return "NaN"
        if isinstance(v, (np.datetime64, np.timedelta64)) and np.isnat(v):
            return "NaT"
    return None


def _cell(v):
    """Display text for one value. A missing value comes as a one-item list, which the grid shows dimmed."""
    gone = _missing(v)
    if gone is not None:
        return [gone]
    if isinstance(v, float):
        return _float_text(v)
    if isinstance(v, (bool, int)):
        return str(v)
    if isinstance(v, str):
        return v if len(v) <= MAX_TEXT else v[:MAX_TEXT] + "…"
    np = _np()
    if np is not None and isinstance(v, np.floating):
        return _float_text(float(v))
    try:
        text = repr(v) if isinstance(v, (list, tuple, dict, set, bytes)) else str(v)
    except Exception as exc:  # noqa: BLE001
        text = "<%s>" % _error_text(exc)
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "…"


def _label(v):
    if isinstance(v, tuple):
        return " / ".join(_label(x) for x in v)
    text = _cell(v)
    return text[0] if isinstance(text, list) else text


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ---------- row order helpers (NumPy when available, lists otherwise) ----------
def _take(positions, start, stop):
    if positions is None:
        return slice(start, stop)
    return positions[start:stop]


def _nonzero(mask):
    np = _np()
    if np is not None:
        return np.flatnonzero(np.asarray(mask, dtype=bool))
    return [i for i, m in enumerate(mask) if m]


def _compose(positions, order):
    if positions is None:
        return order
    np = _np()
    if np is not None:
        return np.asarray(positions)[np.asarray(order)]
    return [positions[i] for i in order]


def _python_order(values, ascending):
    """Stable order of plain Python values, missing ones last; mixed types fall back to their text."""
    present = [i for i, v in enumerate(values) if _missing(v) is None]
    missing = [i for i, v in enumerate(values) if _missing(v) is not None]
    try:
        present.sort(key=lambda i: values[i], reverse=not ascending)
    except TypeError:
        present.sort(key=lambda i: str(values[i]), reverse=not ascending)
    return present + missing


# ---------- tables ----------
class PandasTable:
    def __init__(self, obj):
        self.df = obj.to_frame(name=obj.name if obj.name is not None else 0) if obj.ndim == 1 else obj
        self.nrows = len(self.df)
        self.names = [_label(c) for c in self.df.columns]
        self.dtypes = [str(t) for t in self.df.dtypes]
        api = sys.modules["pandas"].api.types
        self.numeric = [bool(api.is_numeric_dtype(t) and not api.is_bool_dtype(t) and not api.is_complex_dtype(t))
                        for t in self.df.dtypes]
        names = [n for n in self.df.index.names if n is not None]
        self.index_name = " / ".join(_label(n) for n in names)

    def index(self, rows):
        return [_label(v) for v in self.df.index[rows]]

    def values(self, ci, rows):
        return [_cell(v) for v in self.df.iloc[rows, ci].tolist()]

    def order(self, ci, positions, ascending):
        col = self.df.iloc[:, ci]
        if positions is not None:
            col = col.iloc[positions]
        col = col.reset_index(drop=True)
        try:
            order = col.sort_values(ascending=ascending, kind="stable", na_position="last").index.to_numpy()
        except TypeError:
            missing = col.isna()
            text = col.astype(str).where(~missing, None)
            order = text.sort_values(ascending=ascending, kind="stable", na_position="last").index.to_numpy()
        return _compose(positions, order)

    def filter(self, expr):
        np = _np()
        mask = self.df.eval(expr, engine="python", local_dict={"np": np, "pd": sys.modules["pandas"]})
        if hasattr(mask, "to_numpy"):
            mask = mask.to_numpy(dtype=bool, na_value=False) if str(mask.dtype) in ("bool", "boolean") else mask.to_numpy()
        mask = np.asarray(mask)
        if mask.dtype != bool or mask.shape != (self.nrows,):
            raise ValueError("The filter must give True or False for every row")
        return np.flatnonzero(mask)

    def stats(self, ci):
        np = _np()
        values = self.df.iloc[:, ci].to_numpy(dtype=float, na_value=np.nan)
        if not values.size or np.isnan(values).all():
            return None
        return [_num(np.nanmin(values)), _num(np.nanmax(values))]

    def to_csv(self, path, positions, sep):
        df = self.df if positions is None else self.df.iloc[positions]
        df.to_csv(path, sep=sep)
        return len(df)


class NumpyTable:
    def __init__(self, arr):
        np = _np()
        self.arr = arr
        self.fields = list(arr.dtype.names or [])
        if self.fields:
            self.nrows = arr.shape[0]
            self.names = self.fields
            dtypes = [arr.dtype.fields[f][0] for f in self.fields]
        else:
            self.nrows = arr.shape[0]
            ncols = 1 if arr.ndim == 1 else arr.shape[1]
            self.names = [str(i) for i in range(ncols)]
            dtypes = [arr.dtype] * ncols
        self.dtypes = [str(d) for d in dtypes]
        self.numeric = [d.kind in "iuf" for d in dtypes]
        self.index_name = ""
        self.np = np

    def column(self, ci):
        if self.fields:
            return self.arr[self.fields[ci]]
        return self.arr if self.arr.ndim == 1 else self.arr[:, ci]

    def index(self, rows):
        return [str(i) for i in range(self.nrows)[rows]] if isinstance(rows, slice) else [str(int(i)) for i in rows]

    def values(self, ci, rows):
        return [_cell(v) for v in self.column(ci)[rows].tolist()]

    def order(self, ci, positions, ascending):
        np = self.np
        col = self.column(ci)
        if positions is not None:
            col = col[positions]
        if col.dtype.kind in "iufb":
            if col.dtype.kind == "f":
                valid = ~np.isnan(col)
                present = np.flatnonzero(valid)
                missing = np.flatnonzero(~valid)
                vals = col[valid]
            else:
                present, missing, vals = np.arange(len(col)), np.arange(0), col
            key = vals if ascending else -vals.astype(float)
            order = np.concatenate([present[np.argsort(key, kind="stable")], missing])
        else:
            order = np.asarray(_python_order(col.tolist(), ascending), dtype=np.int64)
        return _compose(positions, order)

    def filter(self, expr):
        np = self.np
        mask = eval(expr, {"__builtins__": builtins, "np": np, "x": self.arr})  # noqa: S307  (the user's own filter)
        mask = np.asarray(mask)
        if mask.dtype != bool or mask.shape != (self.nrows,):
            raise ValueError("The filter must give one True or False per row, for example x[:, 0] > 0")
        return np.flatnonzero(mask)

    def stats(self, ci):
        np = self.np
        values = self.column(ci) if self.fields else self.arr
        if values.dtype.kind not in "iuf" or not values.size:
            return None
        if values.dtype.kind == "f" and np.isnan(values).all():
            return None
        return [_num(np.nanmin(values)), _num(np.nanmax(values))]

    def to_csv(self, path, positions, sep):
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, delimiter=sep)
            w.writerow([""] + self.names)
            n = self.nrows if positions is None else len(positions)
            for start in range(0, n, 10000):
                rows = _take(positions, start, min(n, start + 10000))
                cols = [self.values(ci, rows) for ci in range(len(self.names))]
                for label, *cells in zip(self.index(rows), *cols):
                    w.writerow([label] + ["" if isinstance(c, list) else c for c in cells])
        return n


class PolarsTable:
    def __init__(self, obj):
        self.df = obj.to_frame() if type(obj).__name__ == "Series" else obj
        self.nrows = self.df.height
        self.names = list(self.df.columns)
        self.dtypes = [str(t) for t in self.df.dtypes]
        self.numeric = [bool(getattr(t, "is_numeric", lambda: False)()) for t in self.df.dtypes]
        self.index_name = ""

    def series(self, ci, rows):
        s = self.df.to_series(ci)
        if isinstance(rows, slice):
            return s.slice(rows.start, rows.stop - rows.start)
        return s.gather(rows)

    def index(self, rows):
        return [str(i) for i in range(self.nrows)[rows]] if isinstance(rows, slice) else [str(int(i)) for i in rows]

    def values(self, ci, rows):
        return [_cell(v) for v in self.series(ci, rows).to_list()]

    def order(self, ci, positions, ascending):
        s = self.df.to_series(ci)
        if positions is not None:
            s = s.gather(positions)
        try:
            order = s.arg_sort(descending=not ascending, nulls_last=True).to_numpy()
        except Exception:  # noqa: BLE001  (unorderable types sort by their text)
            order = s.cast(str).arg_sort(descending=not ascending, nulls_last=True).to_numpy()
        return _compose(positions, order)

    def filter(self, expr):
        pl = sys.modules["polars"]
        mask = self.df.select(pl.sql_expr(expr).alias("__pyide_mask")).to_series().fill_null(False)
        if str(mask.dtype) != "Boolean":
            raise ValueError("The filter must give True or False for every row")
        return _nonzero(mask.to_numpy())

    def stats(self, ci):
        s = self.df.to_series(ci)
        try:
            return [_num(s.min()), _num(s.max())]
        except Exception:  # noqa: BLE001
            return None

    def to_csv(self, path, positions, sep):
        df = self.df if positions is None else self.df[positions]
        df.write_csv(path, separator=sep)
        return df.height


class RecordsTable:
    """A list or tuple of dicts, one row per dict and one column per key (in order of first appearance)."""

    def __init__(self, rows):
        self.rows = rows
        self.nrows = len(rows)
        keys = {}
        for r in rows:
            for k in r:
                keys.setdefault(k, None)
        self.keys = list(keys)
        self.names = [_label(k) for k in self.keys]
        self.dtypes, self.numeric = [], []
        for k in self.keys:
            seen = {type(r[k]).__name__ for r in islice(rows, 1000) if r.get(k) is not None}
            numeric = bool(seen) and seen <= {"int", "float"}
            self.dtypes.append(seen.pop() if len(seen) == 1 else "object")
            self.numeric.append(numeric)
        self.index_name = ""

    def _rows(self, rows):
        if isinstance(rows, slice):
            return self.rows[rows]
        return [self.rows[int(i)] for i in rows]

    def index(self, rows):
        return [str(i) for i in range(self.nrows)[rows]] if isinstance(rows, slice) else [str(int(i)) for i in rows]

    def values(self, ci, rows):
        k = self.keys[ci]
        return [_cell(r.get(k)) for r in self._rows(rows)]

    def order(self, ci, positions, ascending):
        k = self.keys[ci]
        rows = self.rows if positions is None else self._rows(positions)
        return _compose(positions, _python_order([r.get(k) for r in rows], ascending))

    def filter(self, expr):
        code = compile(expr, "<filter>", "eval")
        env = {"__builtins__": builtins}
        out = []
        for i, r in enumerate(self.rows):
            env["row"] = r
            if eval(code, env, r):  # noqa: S307  (the user's own filter)
                out.append(i)
        np = _np()
        return np.asarray(out, dtype=np.int64) if np is not None else out

    def stats(self, ci):
        k = self.keys[ci]
        nums = [v for v in (_num(r.get(k)) for r in self.rows) if v is not None]
        return [min(nums), max(nums)] if nums else None

    def to_csv(self, path, positions, sep):
        rows = self.rows if positions is None else self._rows(positions)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, delimiter=sep)
            w.writerow(self.names)
            for r in rows:
                w.writerow(["" if _missing(r.get(k)) is not None else r.get(k) for k in self.keys])
        return len(rows)


# ---------- slicing arrays with more than two dimensions ----------
def default_slice(arr):
    return "[%s]" % ", ".join(["0"] * (arr.ndim - 2) + [":", ":"])


def _parse_index(text):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    parts = []
    for part in text.split(","):
        part = part.strip()
        if part == "...":
            parts.append(Ellipsis)
        elif ":" in part:
            bounds = [int(b) if b.strip() else None for b in part.split(":")]
            if len(bounds) > 3:
                raise ValueError("Bad slice %r" % part)
            parts.append(slice(*bounds))
        elif part:
            parts.append(int(part))
    return tuple(parts)


def _sliced(arr, text):
    if arr.ndim <= 2 and not text:
        return arr, ""
    text = text or default_slice(arr)
    out = arr[_parse_index(text)]
    if getattr(out, "ndim", 0) == 0:
        out = out.reshape(1)
    if out.ndim > 2:
        raise ValueError("The slice %s still has %d dimensions; the Data View shows one or two" % (text, out.ndim))
    return out, text


# ---------- views: a table with a filter and a sort applied ----------
def _table(obj, slice_text):
    mod = _module_of(obj)
    if mod == "pandas":
        return PandasTable(obj), ""
    if mod == "polars":
        return PolarsTable(obj), ""
    np = _np()
    if np is not None and isinstance(obj, np.ndarray):
        arr, text = _sliced(np.asarray(obj), slice_text)
        return NumpyTable(arr), text
    return RecordsTable(obj), ""


class View:
    def __init__(self, obj, req):
        self.obj = obj
        self.table, self.slice = _table(obj, req.get("slice") or "")
        self.filter_text = (req.get("filter") or "").strip()
        self.positions = self.table.filter(self.filter_text) if self.filter_text else None
        sort = req.get("sort")
        if sort:
            self.positions = self.table.order(int(sort[0]), self.positions, bool(sort[1]))
        self.rows = self.table.nrows if self.positions is None else len(self.positions)
        self._stats = {}

    def info(self):
        t = self.table
        obj = self.obj
        info = {
            "kind": kind(obj), "type": _type_name(obj), "shape": _shape(obj), "rows": self.rows, "total": t.nrows,
            "columns": [{"name": n, "dtype": d, "numeric": num} for n, d, num in zip(t.names, t.dtypes, t.numeric)],
            "indexName": t.index_name, "slice": self.slice, "ndim": getattr(obj, "ndim", 2),
        }
        if isinstance(t, NumpyTable) and not t.fields:
            info["heat"] = "all"
        return info

    def page(self, start, count, col_start, col_count, heat):
        t = self.table
        start = max(0, min(start, self.rows))
        stop = max(start, min(self.rows, start + count))
        rows = _take(self.positions, start, stop)
        cols = range(max(0, col_start), min(len(t.names), col_start + col_count))
        columns = [t.values(ci, rows) for ci in cols]
        out = {"start": start, "index": t.index(rows), "colStart": cols.start,
               "cells": [list(r) for r in zip(*columns)] if columns else [[] for _ in range(stop - start)]}
        if heat:
            out["stats"] = {str(ci): self.stats(ci) for ci in cols if t.numeric[ci]}
        return out

    def stats(self, ci):
        if isinstance(self.table, NumpyTable) and not self.table.fields:
            ci = 0
        if ci not in self._stats:
            self._stats[ci] = self.table.stats(ci)
        return self._stats[ci]

    def to_csv(self, path, sep):
        return {"rows": self.table.to_csv(path, self.positions, sep), "path": path}


def _view(obj, req):
    key = (req.get("key") or id(obj), req.get("slice") or "", (req.get("filter") or "").strip(),
           tuple(req.get("sort") or ()), req.get("gen"))
    view = _cache.get(key)
    if view is not None and (req.get("key") or view.obj is obj):
        _cache.move_to_end(key)
        return view
    view = View(obj, req)
    _cache[key] = view
    while len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return view
