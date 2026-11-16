//! Graphic clips as data (port of the data part of `graphic.js`, docs/cut-architecture.md section 6): the layer kinds
//! and their fields with types, defaults and ranges, the check of a layer list, the normalized form a command stores,
//! and SVG path data parsed into segments. Drawing a graphic belongs to the engine.

use serde_json::{Map, Value as Json, json};

use crate::captionwords::is_space;
use crate::masks::js_number;
use crate::migrate::js_string;

/// The kinds of layer a graphic is made of.
pub const KINDS: [&str; 9] = ["rect", "ellipse", "polygon", "star", "line", "path", "text", "group", "particles"];
/// The blend modes a layer may name (the canvas composite operation each stands for is the engine's).
pub const BLENDS: [&str; 7] = ["normal", "add", "screen", "multiply", "overlay", "lighten", "darken"];
pub const MAX_LAYERS: usize = 200;
/// Shapes drawn a frame at most: every layer's copies, times its particles.
pub const MAX_WORK: f64 = 20000.0;
const P: f64 = 20000.0;

/// What a field holds, with its bounds (`FIELDS`' types).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FieldType {
    Num(f64, f64),
    Int(f64, f64),
    /// `[x, y]`, each between the bounds.
    Pair(f64, f64),
    /// `#rrggbb`, `#rrggbbaa` or null.
    ColorOrNull,
    Enum(&'static [&'static str]),
    Bool,
    /// Text of at most this many UTF-16 units.
    Str(usize),
    /// A layer id or null.
    IdOrNull,
    /// `{type, from, to, stops}` or null.
    GradientOrNull,
    /// `[dash, gap]` in pixels or null.
    DashOrNull,
}

/// A field's default.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FieldDefault {
    Num(f64),
    Pair(f64, f64),
    Bool(bool),
    Str(&'static str),
    Null,
}

impl FieldDefault {
    pub fn to_json(self) -> Json {
        match self {
            FieldDefault::Num(x) => json!(x),
            FieldDefault::Pair(x, y) => json!([x, y]),
            FieldDefault::Bool(b) => json!(b),
            FieldDefault::Str(s) => json!(s),
            FieldDefault::Null => Json::Null,
        }
    }
}

/// A layer field: name, type, default.
pub type Field = (&'static str, FieldType, FieldDefault);

use FieldDefault as D;
use FieldType as T;

/// Every field a layer of some kind may have (`FIELDS`).
pub const FIELDS: &[Field] = &[
    ("name", T::Str(80), D::Str("")),
    ("parent", T::IdOrNull, D::Null),
    ("visible", T::Bool, D::Bool(true)),
    ("position", T::Pair(-P, P), D::Pair(0.0, 0.0)),
    ("anchor", T::Pair(-P, P), D::Pair(0.0, 0.0)),
    ("scale", T::Pair(-10000.0, 10000.0), D::Pair(100.0, 100.0)),
    ("rotation", T::Num(-36000.0, 36000.0), D::Num(0.0)),
    ("opacity", T::Num(0.0, 100.0), D::Num(100.0)),
    ("blend", T::Enum(&BLENDS), D::Str("normal")),
    ("blur", T::Num(0.0, 500.0), D::Num(0.0)),
    ("shadowColor", T::ColorOrNull, D::Null),
    ("shadowBlur", T::Num(0.0, 500.0), D::Num(0.0)),
    ("shadowOffset", T::Pair(-2000.0, 2000.0), D::Pair(0.0, 0.0)),
    ("repeatCount", T::Int(1.0, 500.0), D::Num(1.0)),
    ("repeatOffset", T::Pair(-P, P), D::Pair(0.0, 0.0)),
    ("repeatRotation", T::Num(-3600.0, 3600.0), D::Num(0.0)),
    ("repeatScale", T::Pair(1.0, 1000.0), D::Pair(100.0, 100.0)),
    ("repeatOpacity", T::Num(0.0, 100.0), D::Num(100.0)),
    ("fill", T::ColorOrNull, D::Str("#ffffff")),
    ("gradient", T::GradientOrNull, D::Null),
    ("stroke", T::ColorOrNull, D::Null),
    ("strokeWidth", T::Num(0.0, 2000.0), D::Num(0.0)),
    ("cap", T::Enum(&["butt", "round", "square"]), D::Str("round")),
    ("join", T::Enum(&["miter", "round", "bevel"]), D::Str("round")),
    ("dash", T::DashOrNull, D::Null),
    ("trimStart", T::Num(0.0, 100.0), D::Num(0.0)),
    ("trimEnd", T::Num(0.0, 100.0), D::Num(100.0)),
    ("trimOffset", T::Num(-100000.0, 100000.0), D::Num(0.0)),
    ("size", T::Pair(0.0, P), D::Pair(400.0, 200.0)),
    ("radius", T::Num(0.0, P), D::Num(0.0)),
    ("innerRadius", T::Num(0.0, P), D::Num(50.0)),
    ("points", T::Int(3.0, 64.0), D::Num(5.0)),
    ("from", T::Pair(-P, P), D::Pair(-200.0, 0.0)),
    ("to", T::Pair(-P, P), D::Pair(200.0, 0.0)),
    ("d", T::Str(20000), D::Str("")),
    ("text", T::Str(2000), D::Str("Text")),
    ("font", T::Str(120), D::Str("")),
    ("fontSize", T::Num(4.0, 1000.0), D::Num(80.0)),
    ("weight", T::Int(100.0, 900.0), D::Num(700.0)),
    ("italic", T::Bool, D::Bool(false)),
    ("align", T::Enum(&["left", "center", "right"]), D::Str("center")),
    ("lineHeight", T::Num(0.5, 4.0), D::Num(1.2)),
    ("letterSpacing", T::Num(-100.0, 500.0), D::Num(0.0)),
    ("value", T::Num(-1e12, 1e12), D::Num(0.0)),
    ("decimals", T::Int(0.0, 6.0), D::Num(0.0)),
    ("reveal", T::Num(0.0, 1.0), D::Num(1.0)),
    ("count", T::Int(1.0, 2000.0), D::Num(60.0)),
    ("seed", T::Int(0.0, 1e9), D::Num(1.0)),
    ("emit", T::Enum(&["stream", "burst"]), D::Str("stream")),
    ("emitter", T::Pair(0.0, P), D::Pair(0.0, 0.0)),
    ("direction", T::Num(-36000.0, 36000.0), D::Num(0.0)),
    ("spread", T::Num(0.0, 360.0), D::Num(360.0)),
    ("speed", T::Num(0.0, P), D::Num(300.0)),
    ("speedVariation", T::Num(0.0, 100.0), D::Num(30.0)),
    ("gravity", T::Pair(-P, P), D::Pair(0.0, 0.0)),
    ("life", T::Num(0.05, 60.0), D::Num(2.0)),
    ("particleSize", T::Num(0.1, 2000.0), D::Num(12.0)),
    ("particleSizeEnd", T::Num(0.0, 2000.0), D::Num(4.0)),
    ("fillEnd", T::ColorOrNull, D::Null),
    ("opacityEnd", T::Num(0.0, 100.0), D::Num(0.0)),
    ("particleShape", T::Enum(&["circle", "square"]), D::Str("circle")),
    ("spin", T::Num(-36000.0, 36000.0), D::Num(0.0)),
];

const COMMON: &[&str] = &[
    "name",
    "parent",
    "visible",
    "position",
    "anchor",
    "scale",
    "rotation",
    "opacity",
    "blend",
    "blur",
    "shadowColor",
    "shadowBlur",
    "shadowOffset",
    "repeatCount",
    "repeatOffset",
    "repeatRotation",
    "repeatScale",
    "repeatOpacity",
];
const PAINT: &[&str] =
    &["fill", "gradient", "stroke", "strokeWidth", "cap", "join", "dash", "trimStart", "trimEnd", "trimOffset"];
/// A group passes on its transform, opacity and visibility; its children draw their own blend, blur and shadow.
const GROUP: &[&str] = &["name", "parent", "visible", "position", "anchor", "scale", "rotation", "opacity"];

fn own(kind: &str) -> Vec<&'static str> {
    let mut v: Vec<&'static str> = match kind {
        "rect" => vec!["size", "radius"],
        "ellipse" => vec!["size"],
        "polygon" => vec!["points", "radius"],
        "star" => vec!["points", "radius", "innerRadius"],
        "line" => {
            return vec!["from", "to", "stroke", "strokeWidth", "cap", "dash", "trimStart", "trimEnd", "trimOffset"];
        }
        "path" => vec!["d"],
        "text" => {
            return vec![
                "text",
                "font",
                "fontSize",
                "weight",
                "italic",
                "align",
                "lineHeight",
                "letterSpacing",
                "value",
                "decimals",
                "reveal",
                "fill",
                "gradient",
                "stroke",
                "strokeWidth",
                "join",
            ];
        }
        "particles" => {
            return vec![
                "count",
                "seed",
                "emit",
                "emitter",
                "direction",
                "spread",
                "speed",
                "speedVariation",
                "gravity",
                "life",
                "particleSize",
                "particleSizeEnd",
                "fill",
                "fillEnd",
                "opacityEnd",
                "particleShape",
                "spin",
            ];
        }
        _ => return Vec::new(),
    };
    v.extend_from_slice(PAINT);
    v
}

/// The fields a layer of this kind has, in order (`fieldsOf`).
pub fn fields_of(kind: &str) -> Vec<&'static str> {
    if kind == "group" {
        return GROUP.to_vec();
    }
    let mut v = COMMON.to_vec();
    v.extend(own(kind));
    v
}

/// A field's type and default.
pub fn field(name: &str) -> Option<&'static Field> {
    FIELDS.iter().find(|f| f.0 == name)
}

/// Whether keyframes may animate this field (`ANIMATED`): numbers, whole numbers, pairs and colors.
pub fn animated(name: &str) -> bool {
    field(name).is_some_and(|f| matches!(f.1, T::Num(..) | T::Int(..) | T::Pair(..) | T::ColorOrNull))
}

/// A field's default for a kind of layer: the kind's own where it has one.
pub fn default_of(kind: &str, name: &str) -> Option<FieldDefault> {
    let own = match (kind, name) {
        ("ellipse", "size") => Some(D::Pair(200.0, 200.0)),
        ("polygon", "points") => Some(D::Num(6.0)),
        ("polygon", "radius") | ("star", "radius") => Some(D::Num(120.0)),
        ("star", "points") => Some(D::Num(5.0)),
        ("star", "innerRadius") => Some(D::Num(55.0)),
        ("line", "stroke") | ("path", "stroke") => Some(D::Str("#ffffff")),
        ("line", "strokeWidth") => Some(D::Num(8.0)),
        ("path", "fill") => Some(D::Null),
        ("path", "strokeWidth") => Some(D::Num(6.0)),
        _ => None,
    };
    own.or_else(|| field(name).map(|f| f.2))
}

fn is_color(s: &str) -> bool {
    crate::validate::is_color(s)
}

fn finite(v: &Json) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn is_layer_id(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// '' when the value fits the field, else what is wrong, for a sentence that starts with the field's name
/// (`checkValue`).
pub fn check_value(name: &str, v: &Json) -> String {
    let Some(&(_, ty, _)) = field(name) else { return "is not a field".into() };
    let range = |a: f64, b: f64| format!(" from {} to {}", js_number(a), js_number(b));
    let ok = |good: bool, why: String| if good { String::new() } else { why };
    match ty {
        T::Num(a, b) => ok(finite(v).is_some_and(|x| x >= a && x <= b), format!("must be a number{}", range(a, b))),
        T::Int(a, b) => ok(
            finite(v).is_some_and(|x| x.fract() == 0.0 && x >= a && x <= b),
            format!("must be a whole number{}", range(a, b)),
        ),
        T::Pair(a, b) => ok(
            v.as_array().is_some_and(|p| p.len() == 2 && p.iter().all(|x| finite(x).is_some_and(|x| x >= a && x <= b))),
            format!("must be [x, y], each{}", range(a, b)),
        ),
        T::ColorOrNull => {
            ok(v.is_null() || v.as_str().is_some_and(is_color), "must be a color #rrggbb or #rrggbbaa, or null".into())
        }
        T::Enum(values) => {
            ok(v.as_str().is_some_and(|s| values.contains(&s)), format!("must be one of {}", values.join(", ")))
        }
        T::Bool => ok(v.is_boolean(), "must be true or false".into()),
        T::Str(max) => ok(
            v.as_str().is_some_and(|s| s.encode_utf16().count() <= max),
            format!("must be text of at most {max} characters"),
        ),
        T::IdOrNull => ok(v.is_null() || v.as_str().is_some_and(is_layer_id), "must be a layer id or null".into()),
        T::DashOrNull => ok(
            v.is_null()
                || v.as_array().is_some_and(|d| {
                    d.len() == 2
                        && d.iter().all(|x| finite(x).is_some_and(|x| (0.0..=P).contains(&x)))
                        && finite(&d[0]).unwrap_or(0.0) + finite(&d[1]).unwrap_or(0.0) > 0.0
                }),
            "must be [dash, gap] in pixels, or null".into(),
        ),
        T::GradientOrNull => {
            if v.is_null() {
                String::new()
            } else {
                gradient_error(v)
            }
        }
    }
}

fn gradient_error(g: &Json) -> String {
    let Some(o) = g.as_object() else { return "must be {type, from, to, stops} or null".into() };
    if let Some(k) = o.keys().find(|k| !["type", "from", "to", "stops"].contains(&k.as_str())) {
        return format!("has no field {k} (type, from, to, stops)");
    }
    if !o.get("type").and_then(Json::as_str).is_some_and(|t| t == "linear" || t == "radial") {
        return "type must be linear or radial".into();
    }
    for k in ["from", "to"] {
        let good = o
            .get(k)
            .and_then(Json::as_array)
            .is_some_and(|p| p.len() == 2 && p.iter().all(|x| finite(x).is_some_and(|x| x.abs() <= P)));
        if !good {
            return format!("{k} must be [x, y] in the layer's pixels");
        }
    }
    let Some(stops) = o.get("stops").and_then(Json::as_array).filter(|s| (2..=16).contains(&s.len())) else {
        return "stops must be 2 to 16 [offset 0..1, color]".into();
    };
    for s in stops {
        let good = s.as_array().is_some_and(|s| {
            s.len() == 2
                && finite(&s[0]).is_some_and(|x| (0.0..=1.0).contains(&x))
                && s[1].as_str().is_some_and(is_color)
        });
        if !good {
            return "each stop must be [offset 0..1, \"#rrggbb\" or \"#rrggbbaa\"]".into();
        }
    }
    String::new()
}

/// Whole numbers as `Number.isInteger` sees them.
fn int(v: Option<&Json>) -> Option<f64> {
    v.and_then(finite).filter(|x| x.fract() == 0.0)
}

/// The problems of a layer list, as sentences (at most 20); empty when it is good (`validate`). Ids must be unique, a
/// parent must be a group earlier in the list, a path's `d` must parse. A layer's fields are checked in the order
/// its JSON object keeps them (by name here; the JavaScript keeps the order they were written in).
pub fn validate(layers: Option<&Json>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut bad = |m: String| {
        if out.len() < 20 {
            out.push(m);
        }
    };
    let Some(layers) = layers.and_then(Json::as_array) else { return vec!["layers must be a list".into()] };
    if layers.len() > MAX_LAYERS {
        bad(format!("a graphic has at most {MAX_LAYERS} layers"));
    }
    let work: f64 = layers
        .iter()
        .filter_map(Json::as_object)
        .map(|l| {
            let copies = int(l.get("repeatCount")).unwrap_or(1.0);
            let each = if l.get("kind").and_then(Json::as_str) == Some("particles") {
                int(l.get("count")).unwrap_or(60.0)
            } else {
                1.0
            };
            copies * each
        })
        .sum();
    if work > MAX_WORK {
        bad(format!(
            "the layers draw {} shapes a frame (copies × particles); at most {}",
            js_number(work),
            js_number(MAX_WORK)
        ));
    }
    let mut seen: Vec<(&str, &str)> = Vec::new();
    for (i, l) in layers.iter().enumerate() {
        let at = format!("layers[{i}]");
        let Some(o) = l.as_object() else {
            bad(format!("{at} must be an object"));
            continue;
        };
        let id = o.get("id").and_then(Json::as_str);
        match id {
            Some(id) if is_layer_id(id) => {
                if seen.iter().any(|(s, _)| *s == id) {
                    bad(format!("{at}.id {id} is used twice"));
                }
            }
            _ => bad(format!("{at}.id must be a short id (letters, digits, _ or -)")),
        }
        let Some(kind) = o.get("kind").and_then(Json::as_str).filter(|k| KINDS.contains(k)) else {
            bad(format!("{at}.kind must be one of {}", KINDS.join(", ")));
            continue;
        };
        let fields = fields_of(kind);
        for (k, v) in o {
            if k == "id" || k == "kind" {
                continue;
            }
            if !fields.contains(&k.as_str()) {
                bad(format!("{at} ({kind}) has no field {k}"));
                continue;
            }
            let e = check_value(k, v);
            if !e.is_empty() {
                bad(format!("{at}.{k} {e}"));
            }
        }
        if let Some(parent) = o.get("parent").filter(|p| !p.is_null()) {
            let found = parent.as_str().and_then(|p| seen.iter().rev().find(|(s, _)| *s == p));
            match found {
                None => bad(format!("{at}.parent {} must be a group earlier in the list", js_string(parent))),
                Some((_, k)) if *k != "group" => {
                    bad(format!("{at}.parent {} is a {k}, not a group", js_string(parent)))
                }
                Some(_) => {}
            }
        }
        if kind == "path" {
            match o.get("d").and_then(Json::as_str) {
                Some(d) if !d.chars().all(is_space) => {
                    if let Err(e) = parse_path(d) {
                        bad(format!("{at}.d: {e}"));
                    }
                }
                _ => bad(format!("{at}.d needs SVG path data")),
            }
        }
        if let Some(id) = id {
            seen.push((id, kind));
        }
    }
    out
}

/// A layer with every field of its kind: the given values over the defaults; fields of other kinds dropped
/// (`normalize`).
pub fn normalize(layer: &Json) -> Json {
    let kind = layer.get("kind").and_then(Json::as_str).filter(|k| KINDS.contains(k)).unwrap_or("rect");
    let mut out = Map::new();
    if let Some(id) = layer.get("id") {
        out.insert("id".into(), id.clone());
    }
    out.insert("kind".into(), json!(kind));
    for f in fields_of(kind) {
        let v = layer.get(f).cloned().unwrap_or_else(|| default_of(kind, f).map_or(Json::Null, FieldDefault::to_json));
        out.insert(f.into(), v);
    }
    Json::Object(out)
}

/// The fields that differ from the defaults (`compact`, what `get_clip` shows).
pub fn compact(layer: &Json) -> Json {
    let n = normalize(layer);
    let kind = n["kind"].as_str().unwrap_or("rect").to_owned();
    let mut base = Map::new();
    if let Some(id) = layer.get("id") {
        base.insert("id".into(), id.clone());
    }
    base.insert("kind".into(), json!(kind));
    let r = normalize(&Json::Object(base));
    let mut out = Map::new();
    if let Some(id) = n.get("id") {
        out.insert("id".into(), id.clone());
    }
    out.insert("kind".into(), json!(kind));
    for f in fields_of(&kind) {
        if !same_value(&n[f], &r[f]) {
            out.insert(f.into(), n[f].clone());
        }
    }
    Json::Object(out)
}

/// Whether two values write the same JSON text (`5` and `5.0` are one number).
fn same_value(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_value(a, b)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|((k, a), (l, b))| k == l && same_value(a, b))
        }
        _ => a == b,
    }
}

// ---------- SVG path data ----------

/// One drawing command of a parsed path, in absolute coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    M(f64, f64),
    L(f64, f64),
    C(f64, f64, f64, f64, f64, f64),
    Q(f64, f64, f64, f64),
}

/// A run of segments from one move.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Subpath {
    pub cmds: Vec<Seg>,
    pub closed: bool,
}

impl Subpath {
    /// As the JavaScript writes it: `{cmds: [['M', x, y], ...], closed}`.
    pub fn to_json(&self) -> Json {
        let cmds: Vec<Json> = self
            .cmds
            .iter()
            .map(|s| match *s {
                Seg::M(x, y) => json!(["M", x, y]),
                Seg::L(x, y) => json!(["L", x, y]),
                Seg::C(a, b, c, d, x, y) => json!(["C", a, b, c, d, x, y]),
                Seg::Q(a, b, x, y) => json!(["Q", a, b, x, y]),
            })
            .collect();
        json!({ "cmds": cmds, "closed": self.closed })
    }
}

/// The length of the number the path pattern `[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?` matches at the start.
fn number_len(b: &[u8]) -> usize {
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut i = usize::from(matches!(b.first(), Some(b'-' | b'+')));
    let int = digits(i);
    if int > 0 {
        i += int;
        if b.get(i) == Some(&b'.') {
            i += 1 + digits(i + 1);
        }
    } else if b.get(i) == Some(&b'.') && digits(i + 1) > 0 {
        i += 1 + digits(i + 1);
    } else {
        return 0;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let s = i + 1 + usize::from(matches!(b.get(i + 1), Some(b'-' | b'+')));
        let e = digits(s);
        if e > 0 {
            i = s + e;
        }
    }
    i
}

/// SVG path data -> its subpaths, or why it cannot be drawn (`parsePath`). Absolute and relative M L H V C S Q T Z;
/// arcs (A) are refused.
pub fn parse_path(d: &str) -> Result<Vec<Subpath>, String> {
    let b = d.as_bytes();
    let mut tokens: Vec<&str> = Vec::new();
    let mut rest = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() {
            tokens.push(&d[i..i + 1]);
            i += 1;
            continue;
        }
        let n = number_len(&b[i..]);
        if n > 0 {
            tokens.push(&d[i..i + n]);
            i += n;
            continue;
        }
        let c = d[i..].chars().next().expect("a character at a char boundary");
        if c != ',' && !is_space(c) {
            rest.push(c);
        }
        i += c.len_utf8();
    }
    if !rest.is_empty() {
        let head: Vec<u16> = rest.encode_utf16().take(10).collect();
        return Err(format!("unexpected \"{}\"", String::from_utf16_lossy(&head)));
    }
    Parser { tokens, i: 0, x: 0.0, y: 0.0, cmd: None }.run()
}

struct Parser<'a> {
    tokens: Vec<&'a str>,
    i: usize,
    x: f64,
    y: f64,
    cmd: Option<&'a str>,
}

/// Whether a token reads as a command: the JavaScript tests `/[a-zA-Z]/`, which a number with an exponent passes.
fn is_command(t: &str) -> bool {
    t.bytes().any(|c| c.is_ascii_alphabetic())
}

impl Parser<'_> {
    fn num(&mut self) -> Result<f64, String> {
        let t = self.tokens.get(self.i).copied();
        self.i += 1;
        match t.and_then(|t| t.parse::<f64>().ok()).filter(|v| v.is_finite()) {
            Some(v) => Ok(v),
            None => Err(format!("a number is missing after {}", self.cmd.unwrap_or("null"))),
        }
    }

    fn run(mut self) -> Result<Vec<Subpath>, String> {
        let mut subpaths: Vec<Subpath> = Vec::new();
        let mut cur: Option<usize> = None;
        let (mut sx, mut sy) = (0.0, 0.0);
        let mut lc: Option<[f64; 2]> = None;
        let mut lq: Option<[f64; 2]> = None;
        while self.i < self.tokens.len() {
            let t = self.tokens[self.i];
            if is_command(t) {
                self.cmd = Some(t);
                self.i += 1;
            } else {
                match self.cmd {
                    None => return Err("path data must start with M".into()),
                    Some("M") => self.cmd = Some("L"),
                    Some("m") => self.cmd = Some("l"),
                    _ => {}
                }
            }
            let cmd = self.cmd.expect("a command");
            let rel = cmd == cmd.to_lowercase();
            let up = cmd.to_uppercase();
            let (ox, oy) = if rel { (self.x, self.y) } else { (0.0, 0.0) };
            if up == "A" {
                return Err("arcs (A) are not supported; draw them with C curves or use an ellipse layer".into());
            }
            if up.len() != 1 || !"MLHVCSQTZ".contains(up.as_str()) {
                return Err(format!("unknown command {cmd}"));
            }
            if up == "Z" {
                if let Some(c) = cur.take() {
                    subpaths[c].closed = true;
                    self.x = sx;
                    self.y = sy;
                }
                lc = None;
                lq = None;
                if self.i < self.tokens.len() && !is_command(self.tokens[self.i]) {
                    return Err("a number after Z".into());
                }
                self.cmd = None;
                continue;
            }
            if up == "M" {
                self.x = ox + self.num()?;
                self.y = oy + self.num()?;
                sx = self.x;
                sy = self.y;
                cur = Some(subpaths.len());
                subpaths.push(Subpath { cmds: vec![Seg::M(self.x, self.y)], closed: false });
                lc = None;
                lq = None;
                continue;
            }
            let c = *cur.get_or_insert_with(|| {
                subpaths.push(Subpath { cmds: vec![Seg::M(self.x, self.y)], closed: false });
                subpaths.len() - 1
            });
            let seg = match up.as_str() {
                "L" => {
                    self.x = ox + self.num()?;
                    self.y = oy + self.num()?;
                    lc = None;
                    lq = None;
                    Seg::L(self.x, self.y)
                }
                "H" => {
                    self.x = ox + self.num()?;
                    lc = None;
                    lq = None;
                    Seg::L(self.x, self.y)
                }
                "V" => {
                    self.y = oy + self.num()?;
                    lc = None;
                    lq = None;
                    Seg::L(self.x, self.y)
                }
                "C" => {
                    let a = [ox + self.num()?, oy + self.num()?, ox + self.num()?, oy + self.num()?];
                    let (x, y) = (ox + self.num()?, oy + self.num()?);
                    lc = Some([a[2], a[3]]);
                    lq = None;
                    self.x = x;
                    self.y = y;
                    Seg::C(a[0], a[1], a[2], a[3], x, y)
                }
                "S" => {
                    let c1 = lc.map_or([self.x, self.y], |l| [2.0 * self.x - l[0], 2.0 * self.y - l[1]]);
                    let a = [ox + self.num()?, oy + self.num()?, ox + self.num()?, oy + self.num()?];
                    lc = Some([a[0], a[1]]);
                    lq = None;
                    self.x = a[2];
                    self.y = a[3];
                    Seg::C(c1[0], c1[1], a[0], a[1], a[2], a[3])
                }
                "Q" => {
                    let a = [ox + self.num()?, oy + self.num()?, ox + self.num()?, oy + self.num()?];
                    lq = Some([a[0], a[1]]);
                    lc = None;
                    self.x = a[2];
                    self.y = a[3];
                    Seg::Q(a[0], a[1], a[2], a[3])
                }
                _ => {
                    let q = lq.map_or([self.x, self.y], |l| [2.0 * self.x - l[0], 2.0 * self.y - l[1]]);
                    let a = [ox + self.num()?, oy + self.num()?];
                    lq = Some(q);
                    lc = None;
                    self.x = a[0];
                    self.y = a[1];
                    Seg::Q(q[0], q[1], a[0], a[1])
                }
            };
            subpaths[c].cmds.push(seg);
        }
        if subpaths.is_empty() {
            return Err("the path draws nothing".into());
        }
        Ok(subpaths)
    }
}
