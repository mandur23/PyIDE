//! The tools' JSON schemas and `check` (control.js): types, required, enums, ranges, lengths, no unknown fields, each
//! refused with the JavaScript's sentence. A schema keeps its properties in the order the table lists them, since
//! the refusal of an unknown argument names the known ones in that order.

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::{Map, Value as Json, json};

/// One JSON schema of a tool's arguments, as control.js writes them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Schema {
    pub types: Vec<String>,
    /// `type` was one string rather than a list.
    single_type: bool,
    pub description: Option<String>,
    pub enumeration: Option<Vec<Json>>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub max_length: Option<usize>,
    pub min_items: Option<usize>,
    pub max_items: Option<usize>,
    pub items: Option<Box<Schema>>,
    pub required: Option<Vec<String>>,
    pub properties: Option<Vec<(String, Schema)>>,
    pub additional: Option<bool>,
}

impl Schema {
    /// The schema as MCP lists it.
    pub fn to_json(&self) -> Json {
        let mut o = Map::new();
        if !self.types.is_empty() {
            o.insert("type".into(), if self.single_type { json!(self.types[0]) } else { json!(self.types) });
        }
        if let Some(d) = &self.description {
            o.insert("description".into(), json!(d));
        }
        if let Some(e) = &self.enumeration {
            o.insert("enum".into(), Json::Array(e.clone()));
        }
        let num = |x: f64| if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) };
        if let Some(x) = self.minimum {
            o.insert("minimum".into(), num(x));
        }
        if let Some(x) = self.maximum {
            o.insert("maximum".into(), num(x));
        }
        for (k, v) in [("maxLength", self.max_length), ("minItems", self.min_items), ("maxItems", self.max_items)] {
            if let Some(n) = v {
                o.insert(k.into(), json!(n));
            }
        }
        if let Some(i) = &self.items {
            o.insert("items".into(), i.to_json());
        }
        if let Some(p) = &self.properties {
            o.insert("properties".into(), Json::Object(p.iter().map(|(k, s)| (k.clone(), s.to_json())).collect()));
        }
        if let Some(r) = &self.required {
            o.insert("required".into(), json!(r));
        }
        if let Some(a) = self.additional {
            o.insert("additionalProperties".into(), json!(a));
        }
        Json::Object(o)
    }

    /// The property `k`'s schema.
    pub fn property(&self, k: &str) -> Option<&Schema> {
        self.properties.as_ref()?.iter().find(|(n, _)| n == k).map(|(_, s)| s)
    }
}

impl<'de> serde::Deserialize<'de> for Schema {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(SchemaVisitor)
    }
}

struct SchemaVisitor;

impl<'de> Visitor<'de> for SchemaVisitor {
    type Value = Schema;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON schema")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Schema, A::Error> {
        let mut s = Schema::default();
        while let Some(k) = m.next_key::<String>()? {
            match k.as_str() {
                "type" => match m.next_value::<Json>()? {
                    Json::String(t) => {
                        s.types = vec![t];
                        s.single_type = true;
                    }
                    Json::Array(a) => s.types = a.into_iter().filter_map(|x| x.as_str().map(str::to_owned)).collect(),
                    _ => return Err(de::Error::custom("type")),
                },
                "description" => s.description = Some(m.next_value()?),
                "enum" => s.enumeration = Some(m.next_value()?),
                "minimum" => s.minimum = Some(m.next_value()?),
                "maximum" => s.maximum = Some(m.next_value()?),
                "maxLength" => s.max_length = Some(m.next_value()?),
                "minItems" => s.min_items = Some(m.next_value()?),
                "maxItems" => s.max_items = Some(m.next_value()?),
                "items" => s.items = Some(Box::new(m.next_value()?)),
                "required" => s.required = Some(m.next_value()?),
                "additionalProperties" => s.additional = Some(m.next_value()?),
                "properties" => s.properties = Some(m.next_value::<Ordered>()?.0),
                other => return Err(de::Error::custom(format!("a schema field control.js does not use: {other}"))),
            }
        }
        Ok(s)
    }
}

/// Properties in the order written.
struct Ordered(Vec<(String, Schema)>);

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("properties")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Schema>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// A number as JavaScript writes it in a string (`${x}`).
pub fn js_num(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".into()
        } else if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{x}");
    }
    let e = format!("{x:e}");
    match e.split_once('e') {
        Some((m, p)) if !p.starts_with('-') => format!("{m}e+{p}"),
        _ => e,
    }
}

/// `JSON.stringify(v)` as JavaScript writes it: numbers without a needless `.0`.
pub fn js_stringify(v: &Json) -> String {
    match v {
        Json::Number(n) => js_num(n.as_f64().unwrap_or(0.0)),
        Json::Array(a) => format!("[{}]", a.iter().map(js_stringify).collect::<Vec<_>>().join(",")),
        Json::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, x)| format!("{}:{}", Json::String(k.clone()), js_stringify(x)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// A JSON value as JavaScript's `${v}` writes it (enum members).
fn js_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => js_num(n.as_f64().unwrap_or(0.0)),
        Json::Null => "null".into(),
        other => other.to_string(),
    }
}

fn is_integer(v: &Json) -> bool {
    v.as_f64().is_some_and(|x| x.is_finite() && x.fract() == 0.0)
}

/// `check(schema, value, at)`: the refusal sentence, or "" when the value fits.
pub fn check(s: &Schema, v: &Json, at: &str) -> String {
    let types = &s.types;
    let has = |t: &str| types.iter().any(|x| x == t);
    if v.is_null() && has("null") {
        return String::new();
    }
    let ty = match v {
        Json::Array(_) => "array",
        Json::Null => "null",
        Json::Number(_) if is_integer(v) && has("integer") => "integer",
        Json::Number(_) => "number",
        Json::String(_) => "string",
        Json::Bool(_) => "boolean",
        Json::Object(_) => "object",
    };
    let ok = types
        .iter()
        .any(|t| t == ty || (t == "number" && ty == "integer") || (t == "integer" && ty == "number" && is_integer(v)));
    if !types.is_empty() && !ok {
        return format!("{at} must be {}.", types.join(" or "));
    }
    let one_of = |e: &[Json]| format!("{at} must be one of {}.", e.iter().map(js_text).collect::<Vec<_>>().join(", "));
    match v {
        Json::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if !x.is_finite() {
                return format!("{at} must be a finite number.");
            }
            if let Some(e) = &s.enumeration
                && !e.iter().any(|m| m.as_f64() == Some(x))
            {
                return one_of(e);
            }
            if let Some(m) = s.minimum
                && x < m
            {
                return format!("{at} must be at least {}.", js_num(m));
            }
            if let Some(m) = s.maximum
                && x > m
            {
                return format!("{at} must be at most {}.", js_num(m));
            }
        }
        Json::String(t) => {
            if let Some(e) = &s.enumeration
                && !e.iter().any(|m| m.as_str() == Some(t))
            {
                return one_of(e);
            }
            if let Some(m) = s.max_length
                && t.encode_utf16().count() > m
            {
                return format!("{at} is longer than {m} characters.");
            }
        }
        Json::Array(a) => {
            if let Some(m) = s.min_items
                && a.len() < m
            {
                return format!("{at} needs at least {m} items.");
            }
            if let Some(m) = s.max_items
                && a.len() > m
            {
                return format!("{at} has more than {m} items.");
            }
            if let Some(items) = &s.items {
                for (i, x) in a.iter().enumerate() {
                    let e = check(items, x, &format!("{at}[{i}]"));
                    if !e.is_empty() {
                        return e;
                    }
                }
            }
        }
        Json::Object(o) => {
            let top = at == "arguments";
            for k in s.required.iter().flatten() {
                if !o.contains_key(k) {
                    return format!("{} needs \"{k}\".", if top { "The call" } else { at });
                }
            }
            for (k, x) in o {
                let Some(p) = s.property(k) else {
                    if s.additional == Some(false) {
                        let known = s.properties.as_ref().map(|p| {
                            let names: Vec<&str> = p.iter().map(|(n, _)| n.as_str()).collect();
                            format!(" (known: {})", if names.is_empty() { "none".into() } else { names.join(", ") })
                        });
                        let head = if top { "There is no argument".to_owned() } else { format!("{at} has no field") };
                        return format!("{head} \"{k}\"{}.", known.unwrap_or_default());
                    }
                    continue;
                };
                let e = check(p, x, &if top { k.clone() } else { format!("{at}.{k}") });
                if !e.is_empty() {
                    return e;
                }
            }
        }
        _ => {}
    }
    String::new()
}
